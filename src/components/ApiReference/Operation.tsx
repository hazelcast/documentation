import React from 'react';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import {Markdown, Parameters, ResponseView, useStore} from 'redoc';
import type {MediaContentModel, OperationModel} from 'redoc';

import {anchorFor} from './anchors';
import {titleFor} from './title';
import styles from './styles.module.css';

// One operation, rendered with the site's own components where Redoc's would
// stand out.
//
// Redoc lays an operation out as two panels: a content panel (title,
// description, parameters, responses) and a dark rail holding the samples. The
// content panel is kept as-is — `Parameters` and `ResponseView` do the genuinely
// hard work of rendering a recursive schema, and reimplementing that would be a
// large amount of code to end up somewhere worse. The rail is what does not
// belong on a docs page: its own tab widget, its own JSON viewer, its own
// syntax theme, all styled for a dark full-height column. That half is replaced
// with @theme/Tabs and @theme/CodeBlock, so a sample here is the same component,
// with the same copy button and the same highlighting, as a sample anywhere else
// in the docs.

// The heading level a menu item renders at, from its depth in the spec's own
// structure: a tag group is an h2, an operation inside one is an h3, and what an
// operation itself is made of is a step below that again — exactly the levels
// this content would carry if it were written in Markdown on any other page.
//
// A spec with no tags (all five Management Center specs) has no group level, so
// its operations start at h2 and nothing about those pages changes.
//
// Clamped at h4 because h5 is already spoken for: it is the level Redoc's own
// field labels use ("PATH PARAMETERS", "REQUEST BODY SCHEMA"), and an operation
// heading landing there would read as one of them. Only a spec nesting groups
// inside groups (`x-tagGroups`) gets deep enough to hit the clamp.
const MAX_LEVEL = 4;

type Level = 2 | 3 | 4;

const clampLevel = (level: number): Level => Math.min(level, MAX_LEVEL) as Level;
const headingTag = (level: number) => `h${clampLevel(level)}` as 'h2' | 'h3' | 'h4';

// `id` has to be unique across every tab in one group: several responses of the
// same operation commonly share a media type, so the media type alone is not it.
type Payload = {id: string; mime: string; label: string; body: unknown};

// The samples a request or response carries, flattened across media types. Redoc
// has already resolved $refs and, where the spec gives no example, generated one
// from the schema — so this only has to read them off the model.
function payloadsOf(content: MediaContentModel | undefined): Payload[] {
  if (!content) {
    return [];
  }
  const payloads: Payload[] = [];
  for (const mediaType of content.mediaTypes) {
    const examples = mediaType.examples ?? {};
    const names = Object.keys(examples);
    for (const name of names) {
      const example = examples[name]!;
      // Name the tab by the media type when there is one example (the usual
      // case), and by the example when a spec offers several to choose between.
      payloads.push({
        id: `${mediaType.name}:${name}`,
        mime: mediaType.name,
        label: names.length > 1 ? example.summary || name : mediaType.name,
        body: example.value,
      });
    }
  }
  return payloads;
}

const languageFor = (mime: string) =>
  /json/i.test(mime) ? 'json' : /xml/i.test(mime) ? 'xml' : /yaml/i.test(mime) ? 'yaml' : 'text';

const format = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function Sample({payload}: {payload: Payload}): React.ReactElement {
  return <CodeBlock language={languageFor(payload.mime)}>{format(payload.body)}</CodeBlock>;
}

// A single sample renders as a plain code block; several render as tabs. No
// groupId: the tab choice is per operation, and syncing every operation on the
// page to one selection would move content the reader is not looking at.
function Samples({
  title,
  level,
  payloads,
}: {
  title: string;
  level: number;
  payloads: Payload[];
}): React.ReactElement | null {
  if (payloads.length === 0) {
    return null;
  }
  const Sub = headingTag(level);
  return (
    <>
      <Sub>{title}</Sub>
      {payloads.length === 1 ? (
        <Sample payload={payloads[0]!} />
      ) : (
        <Tabs>
          {payloads.map((payload) => (
            <TabItem key={payload.id} value={payload.id} label={payload.label}>
              <Sample payload={payload} />
            </TabItem>
          ))}
        </Tabs>
      )}
    </>
  );
}

export function ApiOperation({
  operation,
  level = 2,
}: {
  operation: OperationModel;
  level?: number;
}): React.ReactElement {
  const store = useStore();
  const subLevel = level + 1;
  const Sub = headingTag(subLevel);
  // The heading, and whether it consumed the description (see ./title).
  const {title, usesDescription} = titleFor(operation);
  const httpColors =
    (store?.options.theme.colors as {http?: Record<string, string>} | undefined)?.http ?? {};
  // Response samples are tabbed by status code, since that is what a reader
  // picks between; a response offering several media types or examples adds
  // those to its own label rather than getting a second row of tabs.
  const responsePayloads = operation.responses.flatMap((response) => {
    const payloads = payloadsOf(response.content);
    return payloads.map((payload) => ({
      ...payload,
      id: `${response.code}:${payload.id}`,
      label: payloads.length > 1 ? `${response.code} · ${payload.label}` : response.code,
    }));
  });

  return (
    // `data-section-id` is what Redoc's own scroll service looks for, and the
    // div keeps Redoc's `id` too so an `#operation/…` link still resolves — it
    // is a real anchor this page used to publish, and it costs nothing to honour.
    // The anchor the page ADVERTISES is the readable one, and it goes on the
    // heading, so it is what the hash-link copies and what the TOC points at.
    <div id={operation.id} data-section-id={operation.id} className={styles.operation}>
      {/* @theme/Heading, not a bare <h2>: it is what renders the hash-link
          affordance on every other heading in the docs. Without it these were
          the one kind of heading on the site a contributor could not get a link
          to by hovering it — which is how a JSON pointer nobody could have
          guessed came to be pasted into the AsciiDoc sources by hand. */}
      <Heading as={headingTag(level)} id={anchorFor(operation)}>
        {title}
      </Heading>
      <p className={styles.endpoint}>
        <span
          className={styles.method}
          style={{color: httpColors[operation.httpVerb?.toLowerCase() ?? ''] ?? 'inherit'}}
        >
          {operation.httpVerb}
        </span>
        <code>{operation.path}</code>
      </p>
      {!usesDescription && operation.description !== undefined && (
        <Markdown source={operation.description} />
      )}
      <Parameters parameters={operation.parameters} body={operation.requestBody} />
      <Samples
        title="Request sample"
        level={subLevel}
        payloads={payloadsOf(operation.requestBody?.content)}
      />
      {/* Redoc's ResponsesList is this exact markup with its own heading
          component in place of <Sub> — a styled h3 at 1.3em and weight 400, fixed
          at that level whatever the operation is. Composing it here instead is
          what puts the responses heading a step below its operation rather than
          level with it (and at the same size as "Response samples" beside it);
          `ResponseView`, which does the recursive schema rendering, is still
          Redoc's. */}
      {operation.responses.length > 0 && (
        <div>
          <Sub>Responses</Sub>
          {operation.responses.map((response) => (
            <ResponseView key={response.code} response={response} />
          ))}
        </div>
      )}
      <Samples title="Response samples" level={subLevel} payloads={responsePayloads} />
    </div>
  );
}

// Redoc's ContentItems, minus its Operation. Sections — tag groups, and the
// markdown headings a spec description can introduce — render as a heading plus
// their description, and their operations nest one level below.
//
// Platform's spec is the first in the corpus to use tags: 9 groups over its 50
// operations. Management Center's five specs declare none, so their menus are
// flat and every operation stays the h2 it was.
export function ApiItems({
  items,
  level = 2,
}: {
  items: readonly any[];
  level?: number;
}): React.ReactElement {
  return (
    <>
      {items.map((item) =>
        item.type === 'operation' ? (
          <ApiOperation key={item.id} operation={item as OperationModel} level={level} />
        ) : (
          <React.Fragment key={item.id}>
            <div data-section-id={item.id}>
              <Heading as={headingTag(level)} id={anchorFor(item)}>
                {titleFor(item).title}
              </Heading>
              {item.description && <Markdown source={item.description} />}
            </div>
            {item.items?.length ? <ApiItems items={item.items} level={level + 1} /> : null}
          </React.Fragment>
        ),
      )}
    </>
  );
}
