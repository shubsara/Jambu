/**
 * Content-script entry point.
 *
 * Injected on demand by the orchestrator, never registered as a static content
 * script (decision D3): it exists on a page only at the moment of an
 * intervention.
 *
 * It listens for one message, renders, and sends back one answer. It reads
 * nothing from the page.
 */
import { renderCard, type CardContent, type CardResponse } from './card.js';

interface ShowCardMessage {
  readonly type: 'jambu:show-card';
  readonly content: CardContent;
  readonly css: string;
}

function isShowCard(message: unknown): message is ShowCardMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'jambu:show-card'
  );
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isShowCard(message)) {
    return false;
  }

  renderCard(document, message.content, message.css, (response: CardResponse) => {
    // The only thing that ever leaves this script: an id and an answer.
    void chrome.runtime.sendMessage({ type: 'jambu:card-response', ...response });
  });

  return false;
});
