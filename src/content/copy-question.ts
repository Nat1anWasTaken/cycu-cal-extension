// "Copy" button at the top right of the question: copies the title and problem statement as
// Markdown. Styled like the toolbar buttons (site Bootstrap + FontAwesome classes, see content.css).
// On the site the statement is #ins, the scrolling child of #instruction.

import { htmlToMarkdown } from './markdown';
import { t } from '../shared/i18n';
import { MATH_TEX_EVENT } from '../shared/protocol';

const FEEDBACK_MS = 1500;

export interface CopyQuestionButton {
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createCopyQuestionButton(): CopyQuestionButton | null {
  const question = document.getElementById('ins') ?? document.getElementById('instruction');
  if (!question) return null;

  // Floated so the first lines wrap around it, and sticky so it stays in view while the question scrolls.
  const root = document.createElement('div');
  root.className = 'cal-ext-copy';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm btn-outline-secondary cal-ext-btn';
  btn.title = t('question.copyTitle');
  const icon = document.createElement('i');
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'cal-ext-btn-text';
  btn.append(icon, text);
  root.append(btn);
  question.prepend(root);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (state: 'idle' | 'copied' | 'failed') => {
    icon.className =
      state === 'idle' ? 'fa-regular fa-copy' : state === 'copied' ? 'fa-solid fa-check' : 'fa-solid fa-xmark';
    text.textContent = t(
      state === 'idle' ? 'question.copy' : state === 'copied' ? 'question.copied' : 'question.copyFailed',
    );
  };
  show('idle');

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    copyText(questionMarkdown(question, root)).then(
      () => show('copied'),
      (err) => {
        console.warn('[cycu-cal-ext] copy failed', err);
        show('failed');
      },
    );
    clearTimeout(timer);
    timer = setTimeout(() => show('idle'), FEEDBACK_MS);
  });

  return {
    setVisible(visible) {
      root.hidden = !visible;
    },
    dispose() {
      clearTimeout(timer);
      root.remove();
    },
  };
}

function questionMarkdown(question: HTMLElement, button: HTMLElement): string {
  document.dispatchEvent(new CustomEvent(MATH_TEX_EVENT)); // main-world tags formulas with their TeX
  const body = htmlToMarkdown(question, { baseUrl: document.baseURI, skip: (n) => n === button });
  const title = document.querySelector('.title-left')?.textContent?.replace(/\s+/g, ' ').trim();
  return title ? `# ${title}\n\n${body}` : body;
}

async function copyText(text: string): Promise<void> {
  // The async Clipboard API needs a secure context; CAL servers on the LAN may be plain HTTP.
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('execCommand copy was rejected');
  } finally {
    area.remove();
  }
}
