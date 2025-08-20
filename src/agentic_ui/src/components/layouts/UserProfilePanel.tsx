import { Button } from "@/components/utils/button";
import { ScrollArea } from "@/components/utils/scroll-area";
import { User, Edit, Settings, Palette, HelpCircle, LogOut, ChevronRight, ChevronLeft, Sun, Moon } from "lucide-react";
import { useState } from "react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils"

type Props = {
    open: boolean;
    onClose: () => void;
    activeTab: string;
    setActiveTab: (tabId: string) => void;
    onLogout: () => void;
};

export default function UserProfilePanel({
    open,
    onClose,
    activeTab,
    setActiveTab,
    onLogout,
}: Props) {
    const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
    const { theme, setTheme } = useTheme();
    
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Overlay */}
            <div
                className="absolute inset-0 bg-black/60 backdrop-blur-md transition-opacity animate-fade-in"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="relative z-10 w-full max-w-5xl mx-4 bg-gradient-card rounded-3xl shadow-2xl border border-border animate-scale-in overflow-hidden">
                <div className="flex h-[40rem]">
                    {/* Left Sidebar - Tabs */}
                    <div 
                        className={`relative bg-gradient-to-br from-background/95 via-secondary/10 to-background/95 border-r border-gradient-primary/20 transition-all duration-500 ease-in-out ${
                            sidebarCollapsed ? 'w-16' : 'w-64'
                        }`}
                        onMouseEnter={() => setSidebarCollapsed(false)}
                        onMouseLeave={() => setSidebarCollapsed(true)}
                    >
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/5 to-transparent"></div>
                        <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-primary/40 to-transparent"></div>

                        {/* Toggle Button */}
                        <Button
                            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                            size="sm"
                            variant="ghost"
                            className="absolute bottom-2 right-0 z-20 w-8 h-8 p-0 hover:bg-primary/10 transition-all duration-200"
                        >
                            {sidebarCollapsed ? (
                                <ChevronRight size={14} className="text-muted-foreground" />
                            ) : (
                                <ChevronLeft size={14} className="text-muted-foreground" />
                            )}
                        </Button>

                        <div className={`relative z-10 p-4 transition-all duration-500 ${sidebarCollapsed ? 'px-2' : 'px-6'}`}>
                            {/* Tab Navigation */}
                            <div className="flex flex-col h-full">
                                <nav className="space-y-2">
                                    {[
                                        { id: "profile", label: "User Profile", icon: User },
                                        { id: "appearance", label: "Appearance", icon: Palette },
                                        { id: "settings", label: "Settings", icon: Settings },
                                        { id: "help", label: "Help", icon: HelpCircle },
                                    ].map((tab) => {
                                        const Icon = tab.icon;
                                        const isActive = activeTab === tab.id;
                                        return (
                                            <div key={tab.id} className="relative">
                                                <button
                                                    onClick={() => setActiveTab(tab.id)}
                                                    className={`group w-full flex items-center ${sidebarCollapsed ? 'justify-center px-2' : 'gap-3 px-4'} py-3 text-left transition-all duration-300 relative overflow-hidden rounded-lg ${
                                                        isActive ? "text-fuchsia-400" : "text-muted-foreground hover:text-foreground"
                                                    }`}
                                                    title={sidebarCollapsed ? tab.label : undefined}
                                                >
                                                    <div
                                                        className={`absolute inset-0 transition-all duration-300 rounded-lg ${
                                                        isActive
                                                            ? "bg-gradient-to-r from-fuchsia-500/10 via-fuchsia-400/15 to-fuchsia-500/10 shadow-[0_0_20px_rgba(217,70,239,0.3)]"
                                                            : "group-hover:bg-gradient-to-r group-hover:from-fuchsia-500/5 group-hover:via-fuchsia-400/8 group-hover:to-fuchsia-500/5 group-hover:shadow-[0_0_15px_rgba(217,70,239,0.2)]"
                                                        }`}
                                                    ></div>

                                                    <div
                                                        className={`absolute ${sidebarCollapsed ? 'left-1/2 -translate-x-1/2 w-2 h-2 rounded-full top-1' : 'left-0 top-0 bottom-0 w-1'} transition-all duration-300 ${
                                                        isActive
                                                            ? "bg-gradient-to-b from-fuchsia-400 to-fuchsia-600 shadow-[0_0_10px_rgba(217,70,239,0.5)]"
                                                            : "group-hover:bg-gradient-to-b group-hover:from-fuchsia-400/50 group-hover:to-fuchsia-600/50 group-hover:shadow-[0_0_8px_rgba(217,70,239,0.3)]"
                                                        }`}
                                                    ></div>

                                                    <div className={`relative z-10 flex items-center ${sidebarCollapsed ? 'justify-center' : 'gap-3'}`}>
                                                        <div
                                                            className={`p-1.5 rounded-lg transition-colors duration-300 ${
                                                                isActive
                                                                ? "bg-fuchsia-500/20 shadow-[0_0_15px_rgba(217,70,239,0.4)]"
                                                                : "bg-transparent group-hover:bg-fuchsia-500/10 group-hover:shadow-[0_0_10px_rgba(217,70,239,0.2)]"
                                                            }`}
                                                        >
                                                            {/* 👇 one constant size keeps the row height stable */}
                                                            <Icon
                                                                size={18}
                                                                className={`transition-colors duration-300 ${
                                                                isActive
                                                                    ? "text-fuchsia-400 drop-shadow-[0_0_5px_rgba(217,70,239,0.8)]"
                                                                    : "group-hover:text-fuchsia-400"
                                                                }`}
                                                            />
                                                        </div>

                                                        {/* label slides / fades but doesn’t re-flow the icon */}
                                                        <span
                                                            className={cn(
                                                                // ❷ smooth width → 0 so label occupies no space when hidden
                                                                "font-medium text-sm whitespace-nowrap overflow-hidden transition-[opacity,max-width,transform] duration-300 origin-left",
                                                                sidebarCollapsed
                                                                ? "max-w-0 opacity-0 -translate-x-7"
                                                                : "max-w-xs opacity-100 translate-x-0"
                                                            )}
                                                        >
                                                            {tab.label}
                                                        </span>
                                                    </div>
                                                </button>
                                            </div>
                                        );
                                    })}
                                </nav>

                                {/* Logout button at the bottom */}
                                <div className="mt-auto pt-2">
                                    <button
                                        onClick={onLogout}
                                        className={`group w-full flex items-center ${sidebarCollapsed ? 'justify-center px-2' : 'gap-3 px-4'} py-3 text-left transition-all duration-300 relative overflow-hidden text-muted-foreground hover:text-foreground hover:bg-destructive/10 rounded-lg`}
                                        title={sidebarCollapsed ? "Logout" : undefined}
                                    >
                                        <div className="absolute inset-0 transition-all duration-300 rounded-lg group-hover:bg-gradient-to-r group-hover:from-fuchsia-500/5 group-hover:via-fuchsia-400/8 group-hover:to-fuchsia-500/5 group-hover:shadow-[0_0_15px_rgba(217,70,239,0.2)]"></div>
                                        <div className={`absolute ${sidebarCollapsed ? 'left-1/2 -translate-x-1/2 w-2 h-2 rounded-full top-1' : 'left-0 top-0 bottom-0 w-1'} transition-all duration-300 group-hover:bg-gradient-to-b group-hover:from-fuchsia-400/50 group-hover:to-fuchsia-600/50 group-hover:shadow-[0_0_8px_rgba(217,70,239,0.3)]`}></div>

                                        <div className={`relative z-10 flex items-center ${sidebarCollapsed ? 'justify-center' : 'gap-3'}`}>
                                            <div className="p-1.5 rounded-lg transition-all duration-300 bg-transparent group-hover:bg-fuchsia-500/10 group-hover:shadow-[0_0_10px_rgba(217,70,239,0.2)]">
                                                <LogOut size={sidebarCollapsed ? 18 : 16} className="transition-all duration-300 group-hover:text-fuchsia-400" />
                                            </div>
                                            {!sidebarCollapsed && (
                                                <span className="font-medium text-sm transition-all duration-300 group-hover:text-fuchsia-300">Logout</span>
                                            )}
                                        </div>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    {/* Right Content Area */}
                    <div className="flex-1 p-10 overflow-y-auto bg-gradient-to-br from-background/98 to-secondary/5 relative">
                        <ScrollArea className="h-full w-full">
                            <div className="pr-6">
                                {activeTab === "profile" && (
                                    <div className="space-y-8 animate-fade-in">
                                        {/* Profile Header */}
                                        <div className="flex items-center gap-8 p-8 bg-gradient-card rounded-2xl shadow-elegant border border-border/50">
                                            <div className="relative">
                                                <div className="w-28 h-28 rounded-full bg-gradient-primary flex items-center justify-center shadow-elegant ring-4 ring-primary/20">
                                                    <User size={48} className="text-primary-foreground" />
                                                </div>
                                                <Button
                                                    size="sm"
                                                    className="absolute -bottom-2 -right-2 w-10 h-10 p-0 rounded-full bg-background border-2 border-border shadow-elegant hover:bg-muted active:bg-fuchsia-500/20 active:border-fuchsia-500/50 active:scale-110 transition-smooth"
                                                    variant="ghost"
                                                >
                                                    <Edit size={16} className="active:text-fuchsia-600" />
                                                </Button>
                                            </div>
                                            <div>
                                                <h3 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">John Doe</h3>
                                                <p className="text-muted-foreground text-lg">john.doe@company.com</p>
                                                <p className="text-sm text-muted-foreground mt-2 px-3 py-1 bg-primary/10 rounded-full inline-block">Senior HR Manager</p>
                                            </div>
                                        </div>

                                        {/* Profile Information */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                            {[
                                                { label: "Full Name", value: "John Doe" },
                                                { label: "Email", value: "john.doe@company.com" },
                                                { label: "Department", value: "Human Resources" },
                                                { label: "Role", value: "Senior HR Manager" },
                                                { label: "Member Since", value: "January 2023" },
                                                { label: "Last Login", value: "Today, 2:30 PM" },
                                            ].map((field) => (
                                                <div
                                                    key={field.label}
                                                    className="space-y-3 p-6 bg-gradient-card rounded-xl shadow-card border border-border/50 hover:shadow-elegant transition-smooth"
                                                >
                                                    <label className="text-sm font-semibold text-primary">{field.label}</label>
                                                    <div className="p-4 bg-muted/30 rounded-xl border border-border/30 text-foreground font-medium">{field.value}</div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                
                                {activeTab === "appearance" && (
                                    <div className="space-y-8 animate-fade-in">
                                        <div className="p-8 bg-gradient-card rounded-2xl shadow-elegant border border-border/50">
                                            <h3 className="text-2xl font-bold bg-gradient-primary bg-clip-text text-transparent mb-2">Appearance Settings</h3>
                                            <p className="text-muted-foreground mb-6">Customize your visual experience</p>
                                        </div>
                                            <div className="space-y-6">
                                                <div className="p-8 bg-gradient-card rounded-xl shadow-card border border-border/50">
                                                    <h4 className="font-semibold text-lg mb-3">Theme</h4>
                                                    <p className="text-sm text-muted-foreground mb-6">Choose your preferred theme</p>
                                                    <div className="grid grid-cols-2 gap-4">
                                                        {[
                                                            { name: "Light", value: "light", icon: Sun },
                                                            { name: "Dark", value: "dark", icon: Moon }
                                                        ].map((themeOption) => {
                                                            const Icon = themeOption.icon;
                                                            const isActive = theme === themeOption.value;
                                                            return (
                                                                <button
                                                                    key={themeOption.value}
                                                                    onClick={() => setTheme(themeOption.value)}
                                                                    className={cn(
                                                                        "p-6 rounded-xl text-center transition-all duration-300 border-2 relative overflow-hidden group",
                                                                        isActive 
                                                                            ? "bg-gradient-to-r from-fuchsia-500/10 via-fuchsia-400/15 to-fuchsia-500/10 border-fuchsia-500/50 shadow-[0_0_20px_rgba(217,70,239,0.3)] scale-105" 
                                                                            : "bg-background border-border hover:bg-muted/50 hover:border-fuchsia-500/30 hover:shadow-[0_0_15px_rgba(217,70,239,0.2)] hover:scale-102"
                                                                    )}
                                                                >
                                                                    <div className={cn(
                                                                        "absolute inset-0 transition-all duration-300",
                                                                        isActive 
                                                                            ? "bg-gradient-to-br from-fuchsia-500/5 to-fuchsia-600/10" 
                                                                            : "group-hover:bg-gradient-to-br group-hover:from-fuchsia-500/2 group-hover:to-fuchsia-600/5"
                                                                    )} />
                                                                    <div className="relative z-10 flex flex-col items-center gap-3">
                                                                        <div className={cn(
                                                                            "p-3 rounded-full transition-all duration-300",
                                                                            isActive 
                                                                                ? "bg-fuchsia-500/20 shadow-[0_0_15px_rgba(217,70,239,0.4)]" 
                                                                                : "bg-muted/50 group-hover:bg-fuchsia-500/10"
                                                                        )}>
                                                                            <Icon 
                                                                                size={24} 
                                                                                className={cn(
                                                                                    "transition-all duration-300",
                                                                                    isActive 
                                                                                        ? "text-fuchsia-400 drop-shadow-[0_0_5px_rgba(217,70,239,0.8)]" 
                                                                                        : "text-muted-foreground group-hover:text-fuchsia-400"
                                                                                )} 
                                                                            />
                                                                        </div>
                                                                        <div className={cn(
                                                                            "font-medium transition-all duration-300",
                                                                            isActive 
                                                                                ? "text-fuchsia-400" 
                                                                                : "text-foreground group-hover:text-fuchsia-400"
                                                                        )}>
                                                                            {themeOption.name}
                                                                        </div>
                                                                        {isActive && (
                                                                            <div className="absolute -top-1 -right-1 w-3 h-3 bg-fuchsia-500 rounded-full shadow-[0_0_10px_rgba(217,70,239,0.6)] animate-pulse" />
                                                                        )}
                                                                    </div>
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            </div>
                                    </div>
                                )}
                                
                                {activeTab === "settings" && (
                                    <div className="space-y-8 animate-fade-in">
                                        <div className="p-8 bg-gradient-card rounded-2xl shadow-elegant border border-border/50">
                                            <h3 className="text-2xl font-bold bg-gradient-primary bg-clip-text text-transparent mb-2">General Settings</h3>
                                            <p className="text-muted-foreground">Configure your application preferences</p>
                                        </div>
                                        <div className="space-y-6">
                                            {[
                                                { title: "Notifications", desc: "Manage your notification preferences" },
                                                { title: "Privacy", desc: "Control your privacy settings" },
                                            ].map((setting) => (
                                                <div
                                                    key={setting.title}
                                                    className="p-8 bg-gradient-card rounded-xl shadow-card border border-border/50 hover:shadow-elegant transition-smooth"
                                                >
                                                    <h4 className="font-semibold text-lg mb-2">{setting.title}</h4>
                                                    <p className="text-sm text-muted-foreground">{setting.desc}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                
                                {activeTab === "help" && (
                                    <div className="space-y-8 animate-fade-in">
                                        <div className="p-8 bg-gradient-card rounded-2xl shadow-elegant border border-border/50">
                                            <h3 className="text-2xl font-bold bg-gradient-primary bg-clip-text text-transparent mb-2">Help & Support</h3>
                                            <p className="text-muted-foreground">Get assistance and learn more</p>
                                        </div>
                                        <div className="space-y-6">
                                            {[
                                                { title: "Documentation", desc: "Access user guides and tutorials" },
                                                { title: "Contact Support", desc: "Get help from our support team" },
                                            ].map((help) => (
                                                <div
                                                    key={help.title}
                                                    className="p-8 bg-gradient-card rounded-xl shadow-card border border-border/50 hover:shadow-elegant transition-smooth"
                                                >
                                                    <h4 className="font-semibold text-lg mb-2">{help.title}</h4>
                                                    <p className="text-sm text-muted-foreground">{help.desc}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </ScrollArea>
                    </div>
                </div>
            </div>
        </div>
    );
}
