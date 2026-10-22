import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { type ReactNode, useEffect, useState } from "react";

// The pieces every settings page is made of.

/** A read from the service, with its error and a reload. */
export function useLoad<T>(
  load: () => Promise<T>,
  /** Read again when this changes; the last data stays until then. */
  key: unknown = null,
): {
  data: T | null;
  error: string | null;
} {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => {
        if (!cancelled) setState({ data, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            data: null,
            error: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state;
}

export function PageTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Heading level={4}>{title}</Heading>
      <Text size="sm" color="secondary">
        {description}
      </Text>
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-6 flex flex-col gap-1">
      <Text size="sm" weight="medium" color="secondary">
        {title}
      </Text>
      <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
        {children}
      </div>
    </section>
  );
}

export function Row({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-4 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <Text size="sm">{title}</Text>
        {description ? (
          <Text size="sm" color="secondary" maxLines={1}>
            {description}
          </Text>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function Note({ text }: { text: string }) {
  return (
    <div className="px-4 py-3">
      <Text size="sm" color="secondary">
        {text}
      </Text>
    </div>
  );
}
