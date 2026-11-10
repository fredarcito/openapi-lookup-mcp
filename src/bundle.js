import { readFile } from "node:fs/promises"
import path from "node:path"
import { parse } from "yaml"

export const EXTERNAL_DOCUMENTS_KEY = "x-external-documents"

const MAX_EXTERNAL_DOCUMENTS = 50
const ENCODING = "utf8"

export const isRemote = location => /^https?:\/\//i.test(location)

const escapePointerKey = key => key.replace(/~/g, "~0").replace(/\//g, "~1")

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

const readDocument = location =>
  (isRemote(location)
    ? fetch(location).then(response => {
        if (!response.ok) throw new Error(`status ${response.status}`)
        return response.text()
      })
    : readFile(location, ENCODING)
  ).then(text => {
    const document = parse(text)
    if (!document || typeof document !== "object") {
      throw new Error("not a YAML or JSON document")
    }
    return document
  })

const loadDocuments = (pendingLocations, documents) => {
  const newLocations = pendingLocations
    .filter(location => !documents.has(location))
    .slice(0, MAX_EXTERNAL_DOCUMENTS - documents.size)
  if (!newLocations.length) return Promise.resolve(documents)
  return Promise.all(
    newLocations.map(location =>
      readDocument(location)
        .catch(() => null)
        .then(document => documents.set(location, document))
    )
  ).then(() =>
    loadDocuments(
      newLocations.flatMap(location =>
        externalLocations(documents.get(location), location)
      ),
      documents
    )
  )
}

const rewriteReferences = (document, baseLocation, rootLocation, documents) =>
  walkReferences(document, node => {
    const { location, pointer } = splitReference(node.$ref, baseLocation)
    if (!location || location === rootLocation) {
      if (location) node.$ref = `#${pointer}`
      return
    }
    if (!documents.get(location)) return
    node.$ref = `#/${EXTERNAL_DOCUMENTS_KEY}/${escapePointerKey(location)}${pointer}`
  })

export const bundleSpec = (spec, source) => {
  const rootLocation = isRemote(source) ? source : path.resolve(source)
  const canReach = location => isRemote(location) || !isRemote(rootLocation)
  const firstLocations = externalLocations(spec, rootLocation).filter(canReach)
  if (!firstLocations.length) return Promise.resolve(spec)
  return loadDocuments(firstLocations, new Map()).then(documents => {
    const loaded = [...documents].filter(([, document]) => document)
    rewriteReferences(spec, rootLocation, rootLocation, documents)
    loaded.forEach(([location, document]) =>
      rewriteReferences(document, location, rootLocation, documents)
    )
    return loaded.length
      ? { ...spec, [EXTERNAL_DOCUMENTS_KEY]: Object.fromEntries(loaded) }
      : spec
  })
}
