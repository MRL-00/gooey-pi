import { Modal } from './ui'

export function NoHarnessPrompt({ onClose, onOpenHarnessSettings }: { onClose(): void; onOpenHarnessSettings(): void }) {
  return (
    <Modal
      title="No Pi family harness detected"
      onClose={onClose}
      footer={<button type="button" className="button button--primary" onClick={onOpenHarnessSettings}>Take me there</button>}
    >
      <p>GooeyPi couldn’t find Pi, OMP, or Prime Agent. Install one to get started.</p>
      <p>If you believe this is a mistake, or know where your Pi family harness is installed, configure its executable path in Harness settings. You can also refresh detection there after installing a harness.</p>
    </Modal>
  )
}
