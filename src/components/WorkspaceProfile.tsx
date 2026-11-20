"use client";

import { OrganizationSwitcher, useClerk, useOrganization } from "@clerk/nextjs";
import { ReceiptText } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Invoices } from "./invoices/Invoices";

type Page = { label: "billing"; url?: never } | { label: string; url: string; icon: ReactNode; content: ReactNode };

export function workspaceProfilePages(organization: string | null, invoicesEnabled: boolean): Page[] {
  if (!organization || !invoicesEnabled) return [];
  return [
    { label: "billing" },
    { label: "Invoices", url: "invoices", icon: <ReceiptText aria-hidden="true" />, content: <Invoices key={organization} organization={organization} /> },
  ];
}

type Slots = Record<string, HTMLDivElement | undefined>;
type SetSlot = (id: string, node?: HTMLDivElement, remove?: boolean) => void;

export function imperativeProfilePages(pages: Page[], setSlot: SetSlot) {
  // Clerk's useCustomPages passes these same callbacks to ClerkJS. The mount
  // targets belong to Clerk; React renders their content from our app tree.
  return pages.map(page => page.url !== undefined ? {
    label: page.label, url: page.url,
    mount: (node: HTMLDivElement) => setSlot(page.url, node),
    unmount: (node?: HTMLDivElement) => setSlot(page.url, node, true),
    mountIcon: (node: HTMLDivElement) => setSlot(`${page.url}:icon`, node),
    unmountIcon: (node?: HTMLDivElement) => setSlot(`${page.url}:icon`, node, true),
  } : { label: page.label });
}

const Profile = createContext<{ pages: Page[]; open?: () => void; invoicesEnabled: boolean }>({ pages: [], invoicesEnabled: false });

export function WorkspaceProfile({ children, organizationId, invoicesEnabled }: {
  children: ReactNode; organizationId: string | null; invoicesEnabled: boolean;
}) {
  const clerk = useClerk();
  const { organization } = useOrganization();
  // A switch can reach Clerk before the server layout for the new workspace.
  // Register only against the organization that the server checked.
  const active = organization?.id === organizationId ? organizationId : null;
  const pages = useMemo(() => workspaceProfilePages(active, invoicesEnabled), [active, invoicesEnabled]);
  const [slots, setSlots] = useState<Slots>({});
  const customPages = useMemo(() => imperativeProfilePages(pages, (id, node, remove) => {
    setSlots(current => {
      if (remove && node && current[id] !== node) return current;
      const target = remove ? undefined : node;
      return current[id] === target ? current : { ...current, [id]: target };
    });
  }), [pages]);
  // Wait for Clerk to identify the active workspace before opening a profile
  // that needs custom pages. A click during a switch would capture an empty list.
  const open = invoicesEnabled && !active ? undefined : () => clerk.openOrganizationProfile({ customPages });
  return (
    <Profile.Provider value={{ pages, open, invoicesEnabled: pages.length > 0 }}>
      {children}
      {pages.flatMap(page => {
        if (!page.url) return [];
        const content = slots[page.url];
        const icon = slots[`${page.url}:icon`];
        return [
          content && createPortal(page.content, content, page.url),
          icon && createPortal(page.icon, icon, `${page.url}:icon`),
        ];
      })}
    </Profile.Provider>
  );
}

export function useWorkspaceProfile() {
  return useContext(Profile);
}

export function WorkspaceSwitcher() {
  const { pages } = useWorkspaceProfile();
  const Page = OrganizationSwitcher.OrganizationProfilePage;
  return (
    <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/app" afterCreateOrganizationUrl="/app">
      {pages.map(page => page.url !== undefined
        ? <Page key={page.url} label={page.label} url={page.url} labelIcon={page.icon}>{page.content}</Page>
        : <Page key={page.label} label={page.label} />)}
    </OrganizationSwitcher>
  );
}
