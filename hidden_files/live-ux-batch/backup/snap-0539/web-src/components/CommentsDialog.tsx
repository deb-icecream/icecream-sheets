/**
 * Comment editor dialog for the Review tab.
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';

interface CommentDialogProps {
  cellLabel: string;
  existing: string;
  onClose: () => void;
  onSave: (text: string) => void;
  onDelete: () => void;
}

export default function CommentDialog({
  cellLabel,
  existing,
  onClose,
  onSave,
  onDelete,
}: CommentDialogProps) {
  const [text, setText] = useState(existing);

  const save = (): void => {
    onSave(text.trim());
    onClose();
  };

  return (
    <A11yDialog title={<>Comment — {cellLabel}</>} onClose={onClose}>
        <div className="dialog-row">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a comment…"
            rows={5}
            style={{ width: '100%', resize: 'vertical' }}
          />
        </div>
        <div className="dialog-actions">
          <button onClick={save}>Save</button>
          {existing && <button onClick={() => { onDelete(); onClose(); }}>Delete</button>}
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
