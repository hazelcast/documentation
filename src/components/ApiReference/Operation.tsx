import React from 'react';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import CodeBlock from '@theme/CodeBlock';
import {Markdown, Parameters, ResponsesList, useStore} from 'redoc';
import type {MediaContentModel, OperationModel} from 'redoc';

import styles from './styles.module.css';

// One operation, rendered with the site's own components where Redoc's would
// stand out.
//
// Redoc lays an operation out as two panels: a content panel (title,
// description, parameters, responses) and a dark rail holding the samples. The
// content panel is kept as-is — `Parameters` and `ResponsesList` do the genuinely
// hard work of rendering a recursive schema, and reimplementing that would be a
// large amount of code to end up somewhere worse. The rail is what does not
// belong on a docs page: its own tab widget, its own JSON viewer, its own
// syntax theme, all styled for a dark full-height column. That half is replaced
// with @theme/Tabs and @theme/CodeBlock, so a sample here is the same component,
// with the same copy button and the same highlighting, as a sample anywhere else
// in the docs.

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
function Samples({title, payloads}: {title: string; payloads: Payload[]}): React.ReactElement | null {
  if (payloads.length === 0) {
    return null;
  }
  return (
    <>
      <h3>{title}</h3>
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

export function ApiOperation({operation}: {operation: OperationModel}): React.ReactElement {
  const store = useStore();
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
    // Both attributes carry the same value: `id` is what an anchor and the
    // page's table of contents resolve against, `data-section-id` is what
    // Redoc's own scroll service looks for.
    <div id={operation.id} data-section-id={operation.id} className={styles.operation}>
      <h2>{operation.name}</h2>
      <p className={styles.endpoint}>
        <span
          className={styles.method}
          style={{color: httpColors[operation.httpVerb?.toLowerCase() ?? ''] ?? 'inherit'}}
        >
          {operation.httpVerb}
        </span>
        <code>{operation.path}</code>
      </p>
      {operation.description !== undefined && <Markdown source={operation.description} />}
      <Parameters parameters={operation.parameters} body={operation.requestBody} />
      <Samples title="Request sample" payloads={payloadsOf(operation.requestBody?.content)} />
      <ResponsesList responses={operation.responses} />
      <Samples title="Response samples" payloads={responsePayloads} />
    </div>
  );
}

// Redoc's ContentItems, minus its Operation. Sections (tag groups, and the
// markdown headings a spec description can introduce) render as a heading plus
// their description; none of the Management Center specs use them today, so this
// is here to keep such a spec from rendering as a blank.
export function ApiItems({items}: {items: readonly any[]}): React.ReactElement {
  return (
    <>
      {items.map((item) =>
        item.type === 'operation' ? (
          <ApiOperation key={item.id} operation={item as OperationModel} />
        ) : (
          <React.Fragment key={item.id}>
            <div id={item.id} data-section-id={item.id}>
              <h2>{item.name}</h2>
              {item.description && <Markdown source={item.description} />}
            </div>
            {item.items?.length ? <ApiItems items={item.items} /> : null}
          </React.Fragment>
        ),
      )}
    </>
  );
}
