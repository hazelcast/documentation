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

// Content panel (Parameters, ResponseView) is Redoc's; the dark samples rail is replaced with the site's Tabs and CodeBlock.

// Heading level from spec depth: tag group h2, operation h3, its parts one below. Specs without tags start operations at h2.
// Clamped at h4 because h5 is Redoc's own field-label level.
const MAX_LEVEL = 4;

type Level = 2 | 3 | 4;

const clampLevel = (level: number): Level => Math.min(level, MAX_LEVEL) as Level;
const headingTag = (level: number) => `h${clampLevel(level)}` as 'h2' | 'h3' | 'h4';

// `id` must be unique across a group's tabs: several responses commonly share a media type.
type Payload = {id: string; mime: string; label: string; body: unknown};

// Redoc has already resolved $refs and generated examples where the spec has none.
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
      // Tab label: the media type, or the example name when a spec offers several.
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

// No groupId: tab choice is per operation.
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
  // Whether the heading consumed the description (see ./title).
  const {title, usesDescription} = titleFor(operation);
  const httpColors =
    (store?.options.theme.colors as {http?: Record<string, string>} | undefined)?.http ?? {};
  // Response samples are tabbed by status code; extra media types/examples go in the label.
  const responsePayloads = operation.responses.flatMap((response) => {
    const payloads = payloadsOf(response.content);
    return payloads.map((payload) => ({
      ...payload,
      id: `${response.code}:${payload.id}`,
      label: payloads.length > 1 ? `${response.code} · ${payload.label}` : response.code,
    }));
  });

  return (
    // `data-section-id` is for Redoc's scroll service; `id` keeps `#operation/…` links resolving. The advertised anchor goes on the heading.
    <div id={operation.id} data-section-id={operation.id} className={styles.operation}>
      {/* @theme/Heading renders the hash-link affordance the rest of the docs have. */}
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
      {/* Composed here (not Redoc's ResponsesList, fixed at h3) so the heading sits a level below its operation. */}
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

// Redoc's ContentItems minus its Operation: sections render as a heading plus description, with operations nested one level below.
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
