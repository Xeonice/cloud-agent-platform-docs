// Qualification-only target selection. UI completion still has to be observed
// through the actual browser; this comparison cannot grant a passed assertion.
export function n01WebContinuity({ sourceWeb, targetWeb, loadedWebRevision }) {
  const valid = (web) =>
    web !== null &&
    typeof web === "object" &&
    typeof web.artifactDigest === "string" &&
    typeof web.webRevision === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(web.artifactDigest) &&
    /^[a-f0-9]{40}$/.test(web.webRevision);
  if (!valid(sourceWeb) || !valid(targetWeb))
    throw new Error("N01_VERIFIED_WEB_COMPONENTS_REQUIRED");
  if (loadedWebRevision !== sourceWeb.webRevision)
    throw new Error("N01_LOADED_SOURCE_WEB_IDENTITY_MISMATCH");
  return {
    sameWeb:
      sourceWeb.artifactDigest === targetWeb.artifactDigest &&
      sourceWeb.webRevision === targetWeb.webRevision,
    source: {
      artifactDigest: sourceWeb.artifactDigest,
      webRevision: sourceWeb.webRevision,
    },
    target: {
      artifactDigest: targetWeb.artifactDigest,
      webRevision: targetWeb.webRevision,
    },
    loadedWebRevision,
  };
}
