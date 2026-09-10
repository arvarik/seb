import { CONFIGURATION_SETTINGS, settingDefinition, validateSetting } from './configuration-registry.js';
import type { SetupPrompt } from './prompt.js';
import { readEnvironmentImport, savedEnvironment, UserConfigurationStore } from './user-configuration.js';

interface EditorOptions {
  prompt: SetupPrompt;
  store: UserConfigurationStore;
  environment: NodeJS.ProcessEnv;
  write: (text: string) => void;
}

export async function importUserEnvironment(path: string, options: EditorOptions): Promise<void> {
  const { changes, ignored } = await readEnvironmentImport(path);
  const names = Object.keys(changes);
  if (!names.length) {
    options.write('The file contains no supported, nonempty settings.\n');
    return;
  }
  options.write('Import these settings for launches from any directory:\n');
  for (const name of names) {
    options.write(`  ${name}${settingDefinition(name)?.secret ? ' (secret hidden)' : ''}\n`);
  }
  if (ignored.length) options.write(`Ignored ${ignored.length} unsupported settings.\n`);
  if (changes.SEB_JUDGMENT_TRACING === 'true') {
    options.write('Judgment tracing exports prompts, answers, and tool data when enabled.\n');
  }
  if (changes.SEB_DEVTOOLS === 'true') options.write('DevTools records full content locally.\n');
  const existing = await options.store.load();
  const providers = [...new Set(names.flatMap((name) => {
    const provider = settingDefinition(name)?.provider;
    return provider ? [provider] : [];
  }))];
  if (!changes.SEB_MODEL_PROVIDER && !existing.models && providers.length > 1) {
    changes.SEB_MODEL_PROVIDER = await options.prompt.select('Select the active model provider',
      providers.map((value) => ({ label: value, value })));
  }
  if (!await options.prompt.confirm('Save these settings? Secrets use a private, unencrypted file.', false)) {
    options.write('Import canceled. Seb saved no settings.\n');
    return;
  }
  await options.store.save(changes);
  reportSaved(Object.keys(changes), options);
  options.write('Seb saved the credentials without contacting the providers. Use model provider setup to verify a key.\n');
}

export async function editUserConfiguration(options: EditorOptions): Promise<void> {
  const groups = [...new Set(CONFIGURATION_SETTINGS.map((setting) => setting.group))];
  const group = await options.prompt.select('Select a settings group', groups.map((value) => ({ label: value, value })));
  while (true) {
    const saved = savedEnvironment(await options.store.load());
    const name = await options.prompt.select('Select a setting', [
      ...CONFIGURATION_SETTINGS.filter((setting) => setting.group === group).map((setting) => ({
        label: `${setting.label} (${setting.name})`, value: setting.name,
        description: setting.secret ? (saved[setting.name] ? 'saved, hidden' : 'not saved')
          : saved[setting.name] ?? `default: ${setting.defaultValue ?? 'not set'}`,
      })),
      { label: 'Done', value: 'done' },
    ]);
    if (name === 'done') return;
    const setting = settingDefinition(name)!;
    const action = await options.prompt.select('Choose an action', [
      { label: 'Change', value: 'change' },
      ...(name === 'SEB_MODEL_PROVIDER' ? [] : [{ label: 'Remove saved value', value: 'remove' }]),
      { label: 'Keep current value', value: 'keep' },
    ]);
    if (action === 'keep') continue;
    let value: string | null = null;
    if (action === 'change') {
      const choices = setting.choices ?? (setting.kind === 'boolean' ? ['true', 'false'] : undefined);
      const defaultValue = saved[name] ?? setting.defaultValue;
      const input = choices
        ? await options.prompt.select(setting.label, choices.map((item) => ({ label: item, value: item })), defaultValue)
        : await options.prompt.text(setting.label, {
          required: true, secret: Boolean(setting.secret),
          ...(!setting.secret && defaultValue ? { defaultValue } : {}),
        });
      value = validateSetting(setting, input);
    }
    if (name === 'SEB_JUDGMENT_TRACING' && value === 'true' &&
        !await options.prompt.confirm('Export prompts, answers, and tool data to Judgment?', false)) continue;
    await options.store.save({ [name]: value });
    reportSaved([name], options);
  }
}

function reportSaved(names: string[], options: EditorOptions): void {
  options.write(`Saved configuration: ${options.store.path}\nPrivate credentials: ${options.store.credentials.path}\n`);
  if (names.some((name) => options.environment[name] !== undefined) ||
      (names.includes('GOOGLE_GENERATIVE_AI_API_KEY') && options.environment.GEMINI_API_KEY !== undefined)) {
    options.write('Your shell overrides some saved settings. Remove those shell variables to use the saved values.\n');
  }
  options.write('The next Seb launch uses these settings from any directory.\n');
}
