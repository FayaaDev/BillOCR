import { Download, LayoutDashboard, LogOut, Radio } from "lucide-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

export function AppSidebar({ view, logoutCsrf }: { view: "dashboard" | "integrations" | "upload"; logoutCsrf: string }) {
  return <Sidebar side="right" variant="inset" collapsible="offcanvas" dir="rtl">
    <SidebarHeader className="ledger-sidebar-header"><a className="ledger-brand" href="/admin"><span>سجل الفواتير</span><small>تشغيل ومراجعة</small></a></SidebarHeader>
    <SidebarContent><SidebarGroup><SidebarGroupContent><SidebarMenu>
      <SidebarMenuItem><SidebarMenuButton isActive={view === "dashboard"} render={<a href="/admin" aria-current={view === "dashboard" ? "page" : undefined} />}><LayoutDashboard />لوحة التحكم</SidebarMenuButton></SidebarMenuItem>
      <SidebarMenuItem><SidebarMenuButton isActive={view === "integrations"} render={<a href="/admin?view=integrations" aria-current={view === "integrations" ? "page" : undefined} />}><Radio />التكاملات</SidebarMenuButton></SidebarMenuItem>
      <SidebarMenuItem><SidebarMenuButton render={<a href="/review/export.xlsx" />}><Download />تصدير</SidebarMenuButton></SidebarMenuItem>
    </SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent>
    <SidebarFooter><form method="post" action="/logout"><input type="hidden" name="logoutCsrf" value={logoutCsrf} /><SidebarMenu><SidebarMenuItem><SidebarMenuButton type="submit"><LogOut />تسجيل الخروج</SidebarMenuButton></SidebarMenuItem></SidebarMenu></form></SidebarFooter>
  </Sidebar>;
}
