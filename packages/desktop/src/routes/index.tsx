import { ChatComposer, ChatComposerInput } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { createFileRoute } from "@tanstack/react-router";

// New-session landing (astryx ai-chat-landing template, simplified): greeting
// + composer. UI-only for now — creating a session means asking the daemon
// (pushPrompt RPC); that wiring is the loopback-attachment slice. Existing
// sessions live in the sidebar.
export const Route = createFileRoute("/")({
  component: NewSession,
});

function NewSession() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-8 px-8 py-12">
      {/* Greeting */}
      <VStack gap={1}>
        <HStack gap={2} vAlign="center">
          <Icon icon={SparklesIcon} size="md" color="accent" />
          <Text type="large" as="h2">
            New session
          </Text>
        </HStack>
        <Text type="display-2" as="h1">
          Where should we start?
        </Text>
      </VStack>

      {/* Composer — UI only until the daemon chat pipeline lands. */}
      <VStack gap={2}>
        <ChatComposer
          onSubmit={() => {}}
          placeholder="Ask anything"
          input={<ChatComposerInput style={{ minHeight: 84 }} />}
        />
        <Text size="sm" color="secondary">
          Session creation lands with the daemon attachment — pick an existing
          session from the sidebar for now.
        </Text>
      </VStack>
    </div>
  );
}
