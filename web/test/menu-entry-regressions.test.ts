import { expect, test } from "bun:test";

async function source(path: string) {
    return Bun.file(new URL(`../src/${path}`, import.meta.url)).text();
}

test("account entry points keep their popovers above workspace layers and isolate clicks", async () => {
    const [topbar, sidebarNav, sidebarFooter] = await Promise.all([
        source("components/layout/workspace-account-menu.tsx"),
        source("components/layout/workspace-sidebar-nav.tsx"),
        source("components/layout/workspace-sidebar-footer.tsx"),
    ]);

    for (const accountSource of [topbar, sidebarNav, sidebarFooter]) {
        expect(accountSource).toContain("zIndex={3000}");
        expect(accountSource).toContain("workspace-account-popover");
        expect(accountSource).toContain("打开个人资料与账户菜单");
        expect(accountSource).toContain("event.stopPropagation()");
    }
});

test("shared action menus stop parent row selection", async () => {
    const [admin, history, chapters] = await Promise.all([
        source("pages/admin/components/admin-ui.tsx"),
        source("pages/create/creation-workspace-history.tsx"),
        source("pages/projects/detail/chapters.tsx"),
    ]);

    expect(admin).toContain("open={menuOpen}");
    expect(admin).toContain("styles={{ root: { zIndex: 3000 } }}");
    expect(admin).toContain("domEvent.stopPropagation()");
    expect(history).toContain("role=\"button\"");
    expect(history).toContain("styles={{ root: { zIndex: 3000 } }}");
    expect(history).toContain("onClick={(event) => event.stopPropagation()}");
    expect(chapters).toContain("aria-label={`${unit.title}更多操作`}");
    expect(chapters).toContain("onClick={(event) => event.stopPropagation()}");
});
