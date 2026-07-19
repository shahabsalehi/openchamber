export type ControlPlaneTestFault =
  | 'alarm-schedule'
  | 'cleanup-finalize'
  | 'delete-before'
  | 'finalize'
  | 'upload-after'
  | 'upload-before'
  | 'upload-put-null'

const faultsByTarget = new WeakMap<object, Map<ControlPlaneTestFault, number>>()

export function setControlPlaneTestFault(
  target: object,
  fault: ControlPlaneTestFault,
  count = 1,
): void {
  let faults = faultsByTarget.get(target)
  if (faults === undefined) {
    faults = new Map()
    faultsByTarget.set(target, faults)
  }
  faults.set(fault, Math.max(0, Math.trunc(count)))
}

export function consumeControlPlaneTestFault(
  target: object,
  fault: ControlPlaneTestFault,
): boolean {
  const faults = faultsByTarget.get(target)
  const remaining = faults?.get(fault) ?? 0
  if (faults === undefined || remaining <= 0) {
    return false
  }
  if (remaining === 1) {
    faults.delete(fault)
    if (faults.size === 0) {
      faultsByTarget.delete(target)
    }
  } else {
    faults.set(fault, remaining - 1)
  }
  return true
}
