import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { parse } from "yaml"
import { downloadText } from "./download.js"

export const EXTERNAL_DOCUMENTS_KEY = "x-external-documents"
export const SKIPPED_DOCUMENTS_KEY = "x-skipped-documents"

const MAX_EXTERNAL_DOCUMENTS = 50
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
const DOCUMENT_TIMEOUT_MS = 15 * 1000
const CONCURRENT_READS = 4
const ENCODING = "utf8"
const ANY_HOST = "*"

export const isRemote = location => /^https?:\/\//i.test(location)

const escapePointerKey = key => key.replace(/~/g, "~0").replace(/\//g, "~1")

const listFromEnvironment = name =>
  (process.env[name] || "")
    .split(",")
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)

const resolveLocation = (file, baseLocation) => {
  if (isRemote(file)) return file
  if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return null
  return isRemote(baseLocation)
    ? new URL(file, baseLocation).href
    : path.resolve(path.dirname(baseLocation), file)
}

const splitReference = (reference, baseLocation) => {
  const [file, fragment = ""] = reference.split("#")
  return {
    location: file ? resolveLocation(file, baseLocation) : baseLocation,
    pointer: fragment,
  }
}

const walkReferences = (node, visit, visited = new WeakSet()) => {
  if (!node || typeof node !== "object" || visited.has(node)) return
  visited.add(node)
  if (typeof node.$ref === "string") visit(node)
  Object.values(node).forEach(child => walkReferences(child, visit, visited))
}

const externalLocations = (document, baseLocation) => {
  const locations = new Set()
  walkReferences(document, node => {
    const { location } = splitReference(node.$ref, baseLocation)
    if (location && location !== baseLocation) locations.add(location)
  })
  return [...locations]
}

const isInside = (directory, file) => {
  const relative = path.relative(directory, file)
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

// A spec may only pull in documents its owner can be assumed to trust:
// a remote spec, other documents on its own origin; a local spec, files
// under the project folder or the spec's own folder. Anything else needs
// an explicit allowance in the environment.
const createPolicy = rootLocation => {
  const allowedHosts = listFromEnvironment("OPENAPI_ALLOWED_REF_HOSTS")
  const rootOrigin = isRemote(rootLocation) ? new URL(rootLocation).origin : ""
  const allowedDirectories = isRemote(rootLocation)
    ? []
    : [
        process.env.OPENAPI_REF_ROOT || process.cwd(),
        path.dirname(rootLocation),
      ]

  const checkRemote = location => {
    const { origin, host, hostname } = new URL(location)
    const isAllowed =
      origin === rootOrigin ||
      allowedHosts.includes(ANY_HOST) ||
      allowedHosts.includes(host.toLowerCase()) ||
      allowedHosts.includes(hostname.toLowerCase())
    if (!isAllowed) {
      throw new Error(
        `host ${host} is not allowed; add it to OPENAPI_ALLOWED_REF_HOSTS to load it`
      )
    }
    return location
  }

  const checkLocal = location => {
    if (rootOrigin) {
      throw new Error("a remote spec cannot read local files")
    }
    return Promise.all([
      realpath(location),
      ...allowedDirectories.map(directory =>
        realpath(directory).catch(() => null)
      ),
    ]).then(([realLocation, ...realDirectories]) => {
      const isAllowed = realDirectories.some(
        directory => directory && isInside(directory, realLocation)
      )
      if (!isAllowed) {
        throw new Error(
          "the file is outside the project folder; set OPENAPI_REF_ROOT to a folder that contains it"
        )
      }
      return realLocation
    })
  }

  return location =>
    Promise.resolve().then(() =>
      isRemote(location) ? checkRemote(location) : checkLocal(location)
    )
}

const readLocalFile = file =>
  stat(file).then(fileStats => {
    if (fileStats.size > MAX_DOCUMENT_BYTES) {
      throw new Error("the file is larger than 10 MB")
    }
    return readFile(file, ENCODING)
  })

const readDocument = (location, checkAllowed) =>
  checkAllowed(location)
    .then(allowedLocation =>
      isRemote(allowedLocation)
        ? downloadText(allowedLocation, {
            maxBytes: MAX_DOCUMENT_BYTES,
            timeoutMs: DOCUMENT_TIMEOUT_MS,
            followRedirects: false,
          })
        : readLocalFile(allowedLocation)
    )
    .then(text => {
      const document = parse(text)
      if (!document || typeof document !== "object") {
        throw new Error("it is not a YAML or JSON document")
      }
      return { document }
    })
    .catch(error => ({ failure: error.message }))

const readInBatches = (locations, read, results = []) => {
  if (!locations.length) return Promise.resolve(results)
  return Promise.all(locations.slice(0, CONCURRENT_READS).map(read)).then(
    batch =>
      readInBatches(locations.slice(CONCURRENT_READS), read, [
        ...results,
        ...batch,
      ])
  )
}

const loadDocuments = (pendingLocations, outcomes, checkAllowed) => {
  const newLocations = [...new Set(pendingLocations)].filter(
    location => !outcomes.has(location)
  )
  const readable = newLocations.slice(0, MAX_EXTERNAL_DOCUMENTS - outcomes.size)
  newLocations
    .slice(readable.length)
    .forEach(location =>
      outcomes.set(location, {
        failure: `more than ${MAX_EXTERNAL_DOCUMENTS} documents are referenced`,
      })
    )
  if (!readable.length) return Promise.resolve(outcomes)
  return readInBatches(readable, location =>
    readDocument(location, checkAllowed)
  ).then(results => {
    readable.forEach((location, index) => outcomes.set(location, results[index]))
    return loadDocuments(
      readable.flatMap(location =>
        externalLocations(outcomes.get(location).document, location)
      ),
      outcomes,
      checkAllowed
    )
  })
}

const rewriteReferences = (document, baseLocation, rootLocation, outcomes) =>
  walkReferences(document, node => {
    const { location, pointer } = splitReference(node.$ref, baseLocation)
    if (!location) return
    if (location === rootLocation) {
      node.$ref = `#${pointer}`
      return
    }
    if (!outcomes.get(location)?.document) return
    node.$ref = `#/${EXTERNAL_DOCUMENTS_KEY}/${escapePointerKey(location)}${pointer}`
  })

const selectOutcomes = (outcomes, field) =>
  Object.fromEntries(
    [...outcomes]
      .filter(([, outcome]) => outcome[field])
      .map(([location, outcome]) => [location, outcome[field]])
  )

export const bundleSpec = (spec, source) => {
  const rootLocation = isRemote(source) ? source : path.resolve(source)
  const firstLocations = externalLocations(spec, rootLocation)
  if (!firstLocations.length) return Promise.resolve(spec)
  return loadDocuments(
    firstLocations,
    new Map(),
    createPolicy(rootLocation)
  ).then(outcomes => {
    const documents = selectOutcomes(outcomes, "document")
    const skipped = selectOutcomes(outcomes, "failure")
    rewriteReferences(spec, rootLocation, rootLocation, outcomes)
    Object.entries(documents).forEach(([location, document]) =>
      rewriteReferences(document, location, rootLocation, outcomes)
    )
    return {
      ...spec,
      ...(Object.keys(documents).length
        ? { [EXTERNAL_DOCUMENTS_KEY]: documents }
        : {}),
      ...(Object.keys(skipped).length
        ? { [SKIPPED_DOCUMENTS_KEY]: skipped }
        : {}),
    }
  })
}
