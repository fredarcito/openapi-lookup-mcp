import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "yaml"

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const RETRY_MIN_AGE_MS = 5 * 60 * 1000
const ENCODING = "utf8"

const cacheDirectory = () =>
  path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "openapi-lookup-mcp"
  )

const cacheFileFor = source =>
  path.join(
    cacheDirectory(),
    `${createHash("sha256").update(source).digest("hex").slice(0, 16)}.json`
  )

const isRemote = source => /^https?:\/\//i.test(source)

const parseSpec = (specText, source) => {
  const spec = parse(specText)
  if (!spec || typeof spec !== "object" || typeof spec.paths !== "object") {
    throw new Error(
      `${source} is not an OpenAPI/Swagger document (it has no "paths")`
    )
  }
  return spec
}

const formatAge = fetchedAt => {
  const totalMinutes = Math.floor((Date.now() - fetchedAt) / 60000)
  if (totalMinutes < 1) return "just now"
  if (totalMinutes < 60) return `${totalMinutes}m ago`
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m ago`
}

export const describeSnapshot = snapshot =>
  [
    snapshot.warning,
    `spec read ${formatAge(snapshot.fetchedAt)} from ${snapshot.label}`,
  ]
    .filter(Boolean)
    .join("\n")

const createRemoteStore = source => {
  const cacheFile = cacheFileFor(source)
  const label = new URL(source).host
  let memory = null

  const readDisk = () =>
    readFile(cacheFile, ENCODING)
      .then(JSON.parse)
      .catch(() => null)

  const download = () =>
    fetch(source)
      .then(response => {
        if (!response.ok) {
          throw new Error(
            `Request to ${source} failed with status ${response.status}`
          )
        }
        return response.text()
      })
      .then(specText => {
        const snapshot = {
          fetchedAt: Date.now(),
          spec: parseSpec(specText, source),
        }
        memory = snapshot
        return mkdir(path.dirname(cacheFile), { recursive: true })
          .then(() => writeFile(cacheFile, JSON.stringify(snapshot)))
          .catch(() => null)
          .then(() => ({ ...snapshot, label, justRead: true }))
      })

  const load = forceRefresh =>
    Promise.resolve(memory || readDisk()).then(cached => {
      const isFresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS
      if (isFresh && !forceRefresh) {
        memory = cached
        return { ...cached, label }
      }
      return download().catch(error => {
        if (!cached) throw error
        return {
          ...cached,
          label,
          warning: `Could not refresh the spec (${error.message}); using the cached copy.`,
        }
      })
    })

  const reloadIfStale = snapshot => {
    const isRecent = Date.now() - snapshot.fetchedAt < RETRY_MIN_AGE_MS
    if (snapshot.justRead || isRecent) return Promise.resolve(null)
    return download().catch(() => null)
  }

  return { load, reloadIfStale }
}

const createFileStore = source => {
  const label = path.basename(source)
  let memory = null

  const load = () =>
    stat(source).then(fileStats => {
      if (memory && memory.modifiedAt === fileStats.mtimeMs) {
        return { ...memory, label }
      }
      return readFile(source, ENCODING).then(specText => {
        memory = {
          modifiedAt: fileStats.mtimeMs,
          fetchedAt: Date.now(),
          spec: parseSpec(specText, source),
        }
        return { ...memory, label, justRead: true }
      })
    })

  return { load, reloadIfStale: () => Promise.resolve(null) }
}

export const createSpecStore = source =>
  isRemote(source) ? createRemoteStore(source) : createFileStore(source)
