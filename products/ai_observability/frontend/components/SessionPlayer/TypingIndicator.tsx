import { MessageTemplate } from 'scenes/max/messages/MessageTemplate'

// Shown during playback while a turn's response is still within its latency
// window — three dots animating like a chat app's "typing" indicator.
export function TypingIndicator(): JSX.Element {
    return (
        <MessageTemplate type="ai" wrapperClassName="max-w-[75%]">
            <span className="flex gap-1 items-center py-0.5" aria-label="Assistant is responding">
                <span className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce [animation-delay:300ms]" />
            </span>
        </MessageTemplate>
    )
}
