export function classify(base, local, remote) {
  if (!base && !local && !remote) return "none";
  if (!base && local && !remote) return "push";
  if (!base && !local && remote) return "pull";
  if (!base && local && remote) {
    return local.hash === remote.hash ? "none" : "conflict-local";
  }
  if (base && local && remote) {
    if (local.hash === base.hash && remote.hash === base.hash) return "none";
    if (local.hash !== base.hash && remote.hash === base.hash) return "push";
    if (local.hash === base.hash && remote.hash !== base.hash) return "pull";
    return local.hash === remote.hash ? "none" : "conflict-local";
  }
  if (base && !local && remote) {
    return remote.hash === base.hash ? "delete-remote" : "conflict-local";
  }
  if (base && local && !remote) {
    return local.hash === base.hash ? "delete-local" : "conflict-local";
  }
  return "none";
}
