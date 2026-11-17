export type ExternalActorContext = Readonly<{
  _actor_type: "external";
  _participant_id: string;
  _authentication: Readonly<{
    _type: "external";
    _authoritative: false;
  }>;
  _source: Readonly<{
    _type: "channel";
    _channel_identity_id: string;
  }>;
}>;

/** The subset of XAuth request state trusted by this application boundary. */
export type TrustedXAuthPrincipal = Readonly<{
  _authenticated: true;
  _auth_type: string;
  _user_id: string;
  _account_id: string;
  _clearance_level: number;
}>;

export type AuthenticatedActorContext = Readonly<{
  _actor_type: "authenticated";
  _participant_id: string;
  _authentication: Readonly<{
    _type: "xauth";
    _authoritative: true;
    _principal: TrustedXAuthPrincipal;
  }>;
}>;

export type ActorContext = ExternalActorContext | AuthenticatedActorContext;

export type ModelSafeActorContext =
  | Readonly<{
      _actor_type: "external";
      _authentication: Readonly<{
        _type: "external";
        _authoritative: false;
      }>;
      _source: Readonly<{ _type: "channel" }>;
    }>
  | Readonly<{
      _actor_type: "authenticated";
      _authentication: Readonly<{
        _type: "xauth";
        _authoritative: true;
      }>;
    }>;

export type ExternalActorResolution = Readonly<{
  _participant_id: string;
  _channel_identity_id: string;
}>;

/** Provider identities establish linkage only; they never establish authorization. */
export function createExternalActorContext(
  resolution: ExternalActorResolution,
): ExternalActorContext {
  return Object.freeze({
    _actor_type: "external",
    _participant_id: resolution._participant_id,
    _authentication: Object.freeze({
      _type: "external",
      _authoritative: false,
    }),
    _source: Object.freeze({
      _type: "channel",
      _channel_identity_id: resolution._channel_identity_id,
    }),
  });
}

export function createAuthenticatedActorContext(input: {
  _participant_id: string;
  _principal: TrustedXAuthPrincipal;
}): AuthenticatedActorContext {
  return Object.freeze({
    _actor_type: "authenticated",
    _participant_id: input._participant_id,
    _authentication: Object.freeze({
      _type: "xauth",
      _authoritative: true,
      _principal: Object.freeze({ ...input._principal }),
    }),
  });
}

/** Remove persistence and principal identifiers before building model context. */
export function toModelSafeActorContext(
  actor: ActorContext,
): ModelSafeActorContext {
  if (actor._actor_type === "authenticated") {
    return Object.freeze({
      _actor_type: "authenticated",
      _authentication: Object.freeze({
        _type: "xauth",
        _authoritative: true,
      }),
    });
  }

  return Object.freeze({
    _actor_type: "external",
    _authentication: Object.freeze({
      _type: "external",
      _authoritative: false,
    }),
    _source: Object.freeze({ _type: "channel" }),
  });
}
