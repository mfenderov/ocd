// The pending-revoke mark: the tombstone.
//
// A box the owner revoked keeps a row: the greatest stale epoch the
// brain has seen. The box is tainted while its heartbeat epoch has not
// rotated past it, and clean once it does.
//
// The mark lives here, not in the mint relay, because the heartbeat,
// the audit, the revoke and the mint all speak it. The mark is what
// they share, and a module that holds what they share is what keeps
// their imports a tree.

// The tombstone row. The epoch is the greatest stale epoch: a box is
// tainted while its heartbeat epoch has not rotated past it, clean once
// it exceeds it.
export interface TombstoneRow {
  box_id: string;
  epoch: number;
}

// Whether the box is still tainted. The rule is the one the mint gate,
// the audit's markers and the console's list all read.
export function isTainted(boxEpoch: number, tombstone: TombstoneRow | undefined): boolean {
  if (!tombstone) {
    return false;
  }
  return boxEpoch <= tombstone.epoch;
}
