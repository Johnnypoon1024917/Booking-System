import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { useConfirm } from '../stores/confirm';

// Renders the currently-active custom dialog (confirm / prompt / alert).
// Mounted once at the app root alongside ToastHost.
export function ConfirmHost() {
  const { active, close } = useConfirm();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  // Reset the prompt field whenever a new dialog opens, and focus it.
  useEffect(() => {
    if (!active) return;
    setText(active.defaultValue ?? '');
    const id = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(id);
  }, [active?.id]);

  if (!active) return null;
  const dialog = active;

  const isPrompt = active.kind === 'prompt';
  const isAlert = active.kind === 'alert';
  const danger = active.tone === 'danger';
  const confirmBlocked = isPrompt && active.required ? !text.trim() : false;

  function confirm() {
    if (isPrompt) close(text);
    else close(true);
  }
  function cancel() {
    if (isPrompt) close(null);
    else close(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Enter confirms (Shift+Enter allowed for multiline prompts).
    if (e.key === 'Enter' && !(dialog.multiline && e.shiftKey)) {
      e.preventDefault();
      if (!confirmBlocked) confirm();
    }
  }

  return (
    <Modal
      title={active.title}
      onClose={cancel}
      footer={
        <>
          <span className="spacer" />
          {!isAlert && (
            <button className="btn-fsd ghost" onClick={cancel}>
              {active.cancelText || 'Cancel'}
            </button>
          )}
          <button
            className={`btn-fsd ${danger ? 'danger' : ''}`}
            disabled={confirmBlocked}
            onClick={confirm}
            autoFocus={!isPrompt}
          >
            {active.confirmText || (isAlert ? 'OK' : danger ? 'Confirm' : 'Confirm')}
          </button>
        </>
      }
    >
      <div className="confirm-body">
        {danger && (
          <div className="confirm-icon danger">
            <AlertTriangle size={20} />
          </div>
        )}
        <div style={{ flex: 1 }}>
          {active.message && <p className="confirm-message">{active.message}</p>}
          {isPrompt && (
            <label style={{ display: 'block', marginTop: active.message ? 10 : 0 }}>
              {active.inputLabel && <span>{active.inputLabel}</span>}
              {active.multiline ? (
                <textarea
                  ref={inputRef}
                  rows={3}
                  value={text}
                  placeholder={active.placeholder}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKeyDown}
                />
              ) : (
                <input
                  ref={inputRef}
                  value={text}
                  placeholder={active.placeholder}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKeyDown}
                />
              )}
            </label>
          )}
        </div>
      </div>
    </Modal>
  );
}
