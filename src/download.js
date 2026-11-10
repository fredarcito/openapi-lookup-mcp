const DEFAULT_TIMEOUT_MS = 30 * 1000

const describeLimit = maxBytes => `${Math.round(maxBytes / (1024 * 1024))} MB`

const readBody = async (response, url, maxBytes) => {
  const declaredSize = Number(response.headers.get("content-length"))
  if (declaredSize > maxBytes) {
    await response.body?.cancel()
    throw new Error(`${url} is larger than ${describeLimit(maxBytes)}`)
  }
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let receivedBytes = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    receivedBytes += value.byteLength
    if (receivedBytes > maxBytes) {
      await reader.cancel()
      throw new Error(`${url} is larger than ${describeLimit(maxBytes)}`)
    }
    text += decoder.decode(value, { stream: true })
  }
}

// Downloads a text document, giving up after a timeout or once the body
// exceeds maxBytes. Redirects are refused unless followRedirects is set.
export const downloadText = (
  url,
  { maxBytes, timeoutMs = DEFAULT_TIMEOUT_MS, followRedirects = true }
) =>
  fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: followRedirects ? "follow" : "manual",
  })
    .catch(error => {
      throw new Error(
        error.name === "TimeoutError"
          ? `Request to ${url} timed out after ${timeoutMs / 1000}s`
          : `Request to ${url} failed (${error.cause?.code || error.message})`
      )
    })
    .then(response => {
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`${url} redirects elsewhere, which is not followed`)
      }
      if (!response.ok) {
        throw new Error(
          `Request to ${url} failed with status ${response.status}`
        )
      }
      return readBody(response, url, maxBytes).catch(error => {
        throw new Error(
          error.name === "TimeoutError"
            ? `Request to ${url} timed out after ${timeoutMs / 1000}s`
            : error.message
        )
      })
    })
