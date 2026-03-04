import React from "react";

interface ModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function Modal({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel
}: ModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="glass max-w-md w-full rounded-2xl p-6">
        <h2 className="text-xl font-semibold text-sand">{title}</h2>
        <p className="mt-3 text-sand/80 leading-relaxed">{description}</p>
        <div className="mt-6 flex gap-3">
          <button
            className="flex-1 rounded-lg border border-sand/30 px-4 py-2 text-sand/80 hover:border-sand"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className="flex-1 rounded-lg bg-mint px-4 py-2 text-ink font-semibold hover:bg-mint/90"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
