/** Presentation data only. Applications validate, resolve and persist it.
 * No field changes Agent/module identity, routing, authorization or capabilities. */
export type XAgentPresentationProfile = Readonly<{
  display_name: string;
  role_description?: string;
  tone?: string;
  preferred_language?: string;
  verbosity?: string;
  custom_instructions?: string;
}>;

export type XAgentGrammaticalAddress = "masculine" | "feminine" | "neutral" | "unspecified";

/** User-editable preferences, deliberately separate from authenticated identity.
 * The application supplies trusted identity/scope to its own resolver. Neither
 * a display name nor these preferences prove identity or grant permissions. */
export type XAgentUserPreferences = Readonly<{
  display_name?: string | null;
  preferred_language?: string;
  grammatical_address?: XAgentGrammaticalAddress;
  communication_preference?: string;
}>;
