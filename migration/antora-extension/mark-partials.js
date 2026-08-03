'use strict'

// AsciiDoc-loader extension (the `config.extensions` form: a `register`
// function called as `register(registry, { file, contentCatalog, config })`,
// see @antora/asciidoc-loader load-asciidoc.js). It wraps every contiguous run
// of blocks that originate from an INCLUDED resource -- a `partial$` fragment or
// a whole-page `.adoc` include -- in HTML-comment sentinels carrying a stable
// resource id:
//
//   <!--hz-partial:start cloud:ROOT:partial$create-api-key.adoc-->
//   ...rendered fragment...
//   <!--hz-partial:end   cloud:ROOT:partial$create-api-key.adoc-->
//
// so the HTML->MDX converter can factor shared fragments back into single-source
// MDX partials instead of duplicating them per page.
//
// Requires `config.sourcemap = true`: block boundaries come from each block's
// source_location. The sentinels are passthrough comments, so stripping the
// `<!--hz-partial:*-->` lines reproduces the un-instrumented golden byte-for-byte
// (verified in the spike) -- the fidelity baseline is unaffected.
//
// Scope/limits (deliberate for v1; the converter is the second gate):
//   - Factors at the OUTERMOST include boundary only. A run whose blocks all
//     come from the same included file is wrapped once, as a unit, and not
//     descended into -- so a partial that itself includes another partial
//     travels with its parent rather than being split.
//   - Only wraps block-level runs. A partial spliced mid-paragraph/-cell has no
//     block of its own to attribute, so it is simply not wrapped here; the
//     converter leaves those inlined.

// Resolve the sentinel id from a block's source_location file. Under Antora the
// include cursor's file is a String augmented with `.src` (component / module /
// family / relative -- include-processor.js); prefer that for a manifest-stable
// id, and fall back to the raw path string if the augmentation did not survive
// the trip through Opal.
function resourceId (srcFile) {
  const src = srcFile && srcFile.src
  if (src && src.component) {
    return `${src.component}:${src.module || 'ROOT'}:${src.family}$${src.relative}`
  }
  return String(srcFile)
}

// Parse an `include::TARGET[...]` target into a manifest-stable id matching
// resourceId(): [version@][component:][module:]family$relative. Bare coordinates
// default to the including page's own component/module. Returns null for targets
// that are not resource includes (no `$`) or families we never factor.
const INCLUDE_RE = /^\s*include::([^[\s]+)\[/
function parseIncludeTarget (target, pageSrc) {
  const dollar = target.indexOf('$')
  // Bare relative include (no family marker): Antora resolves it to the
  // INCLUDING file's family, so a page including `x.adoc` is a page$ include.
  // (This is how the cloud page$ tag-slices are authored.)
  if (dollar === -1) {
    if (!target.endsWith('.adoc') || target.includes(':') || !pageSrc) return null
    const family = pageSrc.family
    if (family !== 'partial' && family !== 'page') return null
    return { id: `${pageSrc.component}:${pageSrc.module || 'ROOT'}:${family}$${target}`, family }
  }
  const coord = target.slice(0, dollar)
  const relative = target.slice(dollar + 1)
  const parts = coord.split(':') // last part is the family; anything before is coordinates
  const family = parts[parts.length - 1]
  if (family !== 'partial' && family !== 'page') return null
  let component = (pageSrc && pageSrc.component) || null
  let module = (pageSrc && pageSrc.module) || 'ROOT'
  if (parts.length === 2) module = parts[0] || module
  else if (parts.length >= 3) { component = parts[parts.length - 3] || component; module = parts[parts.length - 2] || module }
  if (!component) return null
  return { id: `${component}:${module}:${family}$${relative}`, family }
}

function createPartialMarker () {
  // 100%-coverage cross-check: one row per (page, included partial/page id),
  // with `marked` set once the tree-processor actually wraps that id. The
  // converter diffs this against the sentinels it factors so an include that is
  // silently left inline (e.g. list-continuation fusion) still shows up.
  const includesRegistry = []
  const marker = {
    register (registry, context) {
      const file = context && context.file
      // The page's own source identity. Top-level (page-authored) blocks report
      // this as their source file; included blocks report the included file.
      const pageFile = file && file.path != null ? String(file.path) : null
      // Line numbers of the page's own `include::` directives. Asciidoctor
      // attributes the FINAL block of an include back to the page at the line of
      // the include directive itself, so a page-attributed block sitting exactly
      // on an include line is that boundary artifact -- genuine partial content,
      // not fused page content. isPure uses this to tell the two apart.
      const includeLines = new Set()
      const contents = file && file.contents ? file.contents.toString() : ''
      contents.split('\n').forEach((ln, i) => { if (/^\s*include::/.test(ln)) includeLines.add(i + 1) })

      // Registry: every partial$/page$ include this page names in source (the
      // 100%-coverage denominator), plus the set the tree-processor ends up
      // marking. Recorded now; markedIds is filled as wrap() emits sentinels.
      const pageSrc = file && file.src
      const pageId = (file && file.pub && file.pub.url) ||
        (pageSrc ? `${pageSrc.component}:${pageSrc.module || 'ROOT'}:${pageSrc.relative}` : String(pageFile))
      const markedIds = new Set()
      const seen = new Set()
      for (const ln of contents.split('\n')) {
        const m = ln.match(INCLUDE_RE)
        if (!m) continue
        const parsed = parseIncludeTarget(m[1], pageSrc)
        if (!parsed || seen.has(parsed.id)) continue
        seen.add(parsed.id)
        includesRegistry.push({ page: pageId, id: parsed.id, family: parsed.family, marked: markedIds })
      }

      registry.treeProcessor(function () {
        this.process((doc) => {
          const createBlock = this.createBlock.bind(this)
          const fileOf = (block) => {
            const loc = block.getSourceLocation && block.getSourceLocation()
            if (!loc || !loc.getFile) return null
            const f = loc.getFile()
            return f == null ? null : f
          }
          const lineOf = (block) => {
            const loc = block.getSourceLocation && block.getSourceLocation()
            return loc && loc.getLineNumber ? loc.getLineNumber() : null
          }
          // The included-file id for a block, or null if it is page-authored (or
          // has no usable source location).
          const includeIdOf = (block) => {
            const f = fileOf(block)
            if (f == null || (pageFile != null && String(f) === pageFile)) return null
            return resourceId(f)
          }
          // A block is PURE (safely liftable as its partial) only if none of its
          // descendants are page-authored. Asciidoctor attributes a whole block
          // to the include even when the page fuses its own content into it -- a
          // `+` list continuation appends page list items to the partial's <ol>,
          // a page paragraph joins the partial's list -- so wrapping the block
          // wholesale would swallow (and, on a single-use include, delete from
          // the page) that page content. Such fused blocks are left inline.
          const isPure = (block) => {
            let pure = true
            const visit = (n) => {
              for (const c of (n.getBlocks && n.getBlocks()) || []) {
                if (!pure) return
                const f = fileOf(c)
                // Page-attributed descendant that is NOT the include-boundary
                // artifact (see includeLines) => genuine fused page content.
                if (f != null && pageFile != null && String(f) === pageFile && !includeLines.has(lineOf(c))) {
                  pure = false; return
                }
                visit(c)
              }
            }
            visit(block)
            return pure
          }

          const wrap = (node) => {
            const blocks = (node.getBlocks && node.getBlocks()) || []
            if (!blocks.length) return
            const out = []
            let i = 0
            const wrappable = (b) => {
              const id = includeIdOf(b)
              // line 0 is the synthetic include-boundary position Asciidoctor
              // gives a PAGE-authored delimited block (e.g. a [%collapsible]
              // example) that merely wraps an include: its chrome is the page's,
              // so recurse into it rather than wrap it. Genuine partial blocks
              // start at line >= 1.
              return id != null && lineOf(b) !== 0 && isPure(b) ? id : null
            }
            while (i < blocks.length) {
              const id = wrappable(blocks[i])
              if (id != null) {
                // Maximal contiguous run of clean same-id blocks: wrap once, as a
                // unit, and do NOT descend (the whole subtree is that partial).
                let j = i
                while (j < blocks.length && wrappable(blocks[j]) === id) j++
                markedIds.add(id)
                out.push(createBlock(node, 'pass', `<!--hz-partial:start ${id}-->`))
                for (let k = i; k < j; k++) out.push(blocks[k])
                out.push(createBlock(node, 'pass', `<!--hz-partial:end ${id}-->`))
                i = j
              } else {
                // Not cleanly wrappable here. Recurse into a page-authored
                // container or a synthetic line-0 wrapper (they may hold clean
                // partial content deeper); but a FUSED include block (impure,
                // line >= 1) is left entirely inline -- descending would wrap a
                // mid-list fragment. Node without source info (id null) counts as
                // page-authored, so we still recurse it.
                const b = blocks[i]
                out.push(b)
                const includeId = includeIdOf(b)
                if (includeId == null || lineOf(b) === 0) wrap(b)
                i++
              }
            }
            node.blocks = out
          }

          wrap(doc)
          return doc
        })
      })
    },
  }
  // Resolve the shared markedIds Set into a per-row boolean at read time (wrap
  // runs after register, during doc.convert()).
  marker.getRegistry = () => includesRegistry.map((r) => ({
    page: r.page, id: r.id, family: r.family, marked: r.marked.has(r.id),
  }))
  return marker
}

// Matches a full sentinel line including its trailing newline, so stripping
// reproduces the un-instrumented golden byte-for-byte (verified across the whole
// cloud golden). The fidelity harness de-instruments golden through this before
// any comparison; keep writer (createPartialMarker) and matcher in lockstep here
// so the two never drift.
const SENTINEL_RE = /^<!--hz-partial:(?:start|end) [^>]*-->\n?/gm
const stripSentinels = (html) => html.replace(SENTINEL_RE, '')

module.exports = { createPartialMarker, resourceId, SENTINEL_RE, stripSentinels }
