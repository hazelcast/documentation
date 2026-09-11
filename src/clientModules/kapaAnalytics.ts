import {pushDataLayer} from '@site/src/lib/analytics';

// The Kapa half of the search analytics: eight callbacks, each pushing one
// dataLayer event. Names and parameters are fixed by the GTM container's
// triggers, not chosen here.
//
// Called from kapa.ts immediately after the queueing stub is installed, rather
// than being its own client module -- registration has to happen after the stub
// exists, and an explicit call says so where a second entry in the clientModules
// array would leave it to the order of that array.
//
// Registering before the bundle has loaded is fine: each `Kapa('onX', fn)` call
// goes into the stub's queue and is replayed once the widget drains it.
export function registerKapaAnalytics(): void {
  const Kapa = window.Kapa;
  if (!Kapa) {
    return;
  }

  const on = (event: string, handler: (data?: Record<string, unknown>) => void) =>
    Kapa(event, handler);

  const str = (data: Record<string, unknown> | undefined, key: string): string =>
    (data?.[key] as string) ?? '';

  on('onModalOpen', () => {
    pushDataLayer('kapa_modal_open', {search_provider: 'kapa'});
  });

  on('onAskAIQuerySubmit', (data) => {
    pushDataLayer('kapa_question_submitted', {
      search_provider: 'kapa',
      question: str(data, 'question'),
    });
  });

  on('onAskAIAnswerCompleted', (data) => {
    pushDataLayer('kapa_answer_completed', {
      search_provider: 'kapa',
      question: str(data, 'question'),
      kapa_thread_id: str(data, 'threadId'),
      kapa_qa_id: str(data, 'questionAnswerId'),
    });
  });

  on('onAskAIGenerationStop', (data) => {
    pushDataLayer('kapa_generation_stopped', {
      search_provider: 'kapa',
      question: str(data, 'question'),
      kapa_thread_id: str(data, 'threadId'),
    });
  });

  on('onAskAIAnswerCopy', (data) => {
    pushDataLayer('kapa_answer_copied', {
      search_provider: 'kapa',
      kapa_thread_id: str(data, 'threadId'),
      kapa_qa_id: str(data, 'questionAnswerId'),
    });
  });

  on('onAskAILinkClick', (data) => {
    pushDataLayer('kapa_link_click', {
      search_provider: 'kapa',
      link_url: str(data, 'href'),
      kapa_thread_id: str(data, 'threadId'),
      kapa_qa_id: str(data, 'questionAnswerId'),
    });
  });

  on('onAskAISourceClick', (data) => {
    const source = (data?.source ?? {}) as {url?: string; title?: string};
    pushDataLayer('kapa_source_click', {
      search_provider: 'kapa',
      link_url: source.url ?? '',
      link_title: source.title ?? '',
      kapa_thread_id: str(data, 'threadId'),
      kapa_qa_id: str(data, 'questionAnswerId'),
    });
  });

  on('onAskAIConversationReset', (data) => {
    pushDataLayer('kapa_conversation_reset', {
      search_provider: 'kapa',
      kapa_thread_id: str(data, 'threadId'),
    });
  });
}
