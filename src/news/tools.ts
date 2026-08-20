import { createGoogle } from '@ai-sdk/google';

type GoogleProvider = ReturnType<typeof createGoogle>;

export function createGroundedNewsTools(google: GoogleProvider) {
  return {
    searchCurrentNews: google.tools.googleSearch({
      searchTypes: { webSearch: {} },
    }),
    readNewsUrl: google.tools.urlContext({}),
  };
}
