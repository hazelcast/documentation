import {pushDataLayer} from '@site/src/lib/analytics';

// Kapa search analytics: each callback pushes one dataLayer event. Names and parameters are
// fixed by the GTM container's triggers.
// Called from kapa.ts right after the queueing stub is installed; calls made before the bundle loads are queued and replayed.
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
