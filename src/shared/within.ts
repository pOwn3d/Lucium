/**
 * What `work` resolves, or `fallback` when it has not answered after `ms`: a page that is busy, hung or on its way to an error page may never
 * answer a question put to it, and whoever asks must not wait for ever. A late answer is dropped; `onLate` is called once when the time ran out.
 * A rejection of `work` is passed on.
 */
export function within<T>(work: Promise<T>, ms: number, fallback: T, onLate?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onLate?.()
      resolve(fallback)
    }, ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
