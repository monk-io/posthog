import { MessageTemplate } from 'scenes/max/messages/MessageTemplate'

// Shown during playback while a turn is still "in flight" — three dots animating
// like a chat app's typing indicator. `type` picks the side/style: the user
// composing their request (right) or the assistant working on its reply (left).
export function TypingIndicator({ type = 'ai' }: { type?: 'human' | 'ai' }): JSX.Element {
    return (
        <MessageTemplate type={type} wrapperClassName="max-w-[75%]">
            <span
                className="flex gap-1 items-center py-0.5"
                aria-label={type === 'human' ? 'User is typing' : 'Assistant is responding'}
            >
                <span className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce [animation-delay:300ms]" />
            </span>
        </MessageTemplate>
    )
}
