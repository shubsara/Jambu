/**
 * The Care Card element (CLAUDE.md §19, decisions D68, D69, D71).
 *
 * Render-only. It is handed the words to show and returns the user's answer.
 * It never reads the DOM, page text, selection, form state, title or URL —
 * the whole point of the shadow root is that the page and the card cannot see
 * each other.
 */

/** What the card needs to display. Nothing about the page appears here. */
export interface CardContent {
  readonly interventionId: string;
  readonly message: string;
  readonly signature: string;
  readonly avatar: string;
  readonly greeting: string;
  readonly confirmLabel: string;
  readonly snoozeLabel: string;
}

/** The only thing the card ever sends back (CLAUDE.md §9). */
export interface CardResponse {
  readonly interventionId: string;
  readonly response: 'confirmed' | 'snoozed' | 'dismissed';
}

export interface CardHandle {
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  remove: () => void;
}

const HOST_ID = 'jambu-care-card';

/** Elements that can hold focus once the user engages with the card (D71). */
function focusable(root: ShadowRoot): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button')];
}

/**
 * Render the card into a shadow root on the given document.
 *
 * `onRespond` is called at most once. The card removes itself immediately so
 * the user never has to watch it linger after answering.
 */
export function renderCard(
  doc: Document,
  content: CardContent,
  css: string,
  onRespond: (response: CardResponse) => void,
): CardHandle {
  // Never two cards at once.
  doc.querySelector(`#${HOST_ID}`)?.remove();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);

  const card = doc.createElement('div');
  card.className = 'jambu-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'A note from Jambu');
  // Decision D71: announced politely, never seizing the screen reader.
  card.setAttribute('aria-live', 'polite');

  const header = doc.createElement('div');
  header.className = 'jambu-header';

  const avatar = doc.createElement('span');
  avatar.className = 'jambu-avatar';
  avatar.textContent = content.avatar;
  avatar.setAttribute('aria-hidden', 'true');

  const greeting = doc.createElement('span');
  greeting.className = 'jambu-greeting';
  greeting.textContent = content.greeting;

  const close = doc.createElement('button');
  close.className = 'jambu-close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');

  header.append(avatar, greeting, close);

  const message = doc.createElement('p');
  message.className = 'jambu-message';
  message.textContent = content.message;

  const actions = doc.createElement('div');
  actions.className = 'jambu-actions';

  const confirm = doc.createElement('button');
  confirm.className = 'jambu-button jambu-button--primary';
  confirm.type = 'button';
  confirm.textContent = content.confirmLabel;

  const snooze = doc.createElement('button');
  snooze.className = 'jambu-button';
  snooze.type = 'button';
  snooze.textContent = content.snoozeLabel;

  actions.append(confirm, snooze);

  const signature = doc.createElement('div');
  signature.className = 'jambu-signature';
  signature.textContent = content.signature;

  card.append(header, message, actions, signature);
  shadow.appendChild(card);
  doc.body.appendChild(host);

  let answered = false;
  let trapping = false;

  const remove = (): void => {
    doc.removeEventListener('keydown', onKeyDown, true);
    host.remove();
  };

  const respond = (response: CardResponse['response']): void => {
    if (answered) {
      return;
    }
    answered = true;
    remove();
    onRespond({ interventionId: content.interventionId, response });
  };

  /**
   * Decision D71: focus is not taken on render. The trap engages only once the
   * user has chosen to interact, so the card cannot steal focus mid-sentence.
   */
  const engage = (): void => {
    trapping = true;
  };
  card.addEventListener('focusin', engage);
  card.addEventListener('mousedown', engage);

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Escape dismisses only when the card has focus, so it cannot swallow
      // the page's own Escape handling.
      if (trapping) {
        event.preventDefault();
        respond('dismissed');
      }
      return;
    }

    if (event.key !== 'Tab' || !trapping) {
      return;
    }

    const items = focusable(shadow);
    const first = items[0];
    const last = items.at(-1);
    if (first === undefined || last === undefined) {
      return;
    }

    const active = shadow.activeElement as HTMLElement | null;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  confirm.addEventListener('click', () => {
    respond('confirmed');
  });
  snooze.addEventListener('click', () => {
    respond('snoozed');
  });
  close.addEventListener('click', () => {
    respond('dismissed');
  });

  doc.addEventListener('keydown', onKeyDown, true);

  return { host, shadow, remove };
}

export { HOST_ID };
