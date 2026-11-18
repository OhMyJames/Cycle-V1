import { Button } from "@ui-sdk/react/button";
import { Textarea } from "@ui-sdk/react/textarea";
import { type KeyboardEvent, useState } from "react";

export type ComposerProps = {
  /** False when there is no session, or it is still being read. */
  enabled: boolean;
  /** A turn is going: the button stops it, and a new prompt waits. */
  working: boolean;
  onSend: (text: string) => void | Promise<void>;
  onStop: () => void | Promise<void>;
};

export function Composer({ enabled, working, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const canSend = enabled && !working && text.trim() !== "";

  const send = async () => {
    if (!canSend) return;
    const sent = text;
    setText("");
    await onSend(sent);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line; Enter that confirms an IME composition is not a send.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div data-slot="composer">
      <Textarea
        autoResize
        aria-label="Message"
        placeholder={
          enabled
            ? working
              ? "The agent is working…"
              : "Message the agent"
            : "Choose or start a session"
        }
        disabled={!enabled}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      {working ? (
        <Button data-variant="outline" onClick={() => onStop()}>
          Stop
        </Button>
      ) : (
        <Button data-variant="solid" disabled={!canSend} onClick={send}>
          Send
        </Button>
      )}
    </div>
  );
}
