import { memo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";
import { VscEye, VscEyeClosed } from "react-icons/vsc";
import Galaxy from "@/components/ui/react_bits/bg_galaxy";

type LoginPanelProps = {
    username: string;
    password: string;
    onUsernameChange: (v: string) => void;
    onPasswordChange: (v: string) => void;
    onSubmit: () => void;
};

const GalaxyBg = memo(() => (
    <div className="absolute inset-0 -z-10 pointer-events-none">
        <Galaxy
            mouseRepulsion={true}
            mouseInteraction={false}
            density={1.5}
            glowIntensity={0.4}
            saturation={0.8}
            hueShift={150}
            transparent={false}
        />
    </div>
), () => true); 

export default function LoginPanel({
    username,
    password,
    onUsernameChange,
    onPasswordChange,
    onSubmit,
}: LoginPanelProps) {
    const [showPassword, setShowPassword] = useState(false);
    return (
        // Force dark styling for the login scene even when global theme is light
        <div className="h-screen flex items-center justify-center dark">
            <GalaxyBg/>
            <Card 
                className="
                    w-full max-w-[min(92vw,32rem)]
                    p-6 sm:p-8 md:p-10
                    mx-auto
                    max-h-[90dvh] overflow-auto
                    bg-background/98 backdrop-blur-xl
                    border border-border/20
                    shadow-2xl animate-scale-in
                    relative overflow-hidden
                    rounded-2xl
                "
            >
                {/* Subtle gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-secondary/5 pointer-events-none"></div>
                
                <div className="relative z-10">
                    <div className="text-center mb-5">
                        <div className="relative inline-block mb-8">
                            <div className="w-24 h-24 mx-auto rounded-full bg-gradient-primary flex items-center justify-center shadow-2xl animate-pulse relative">
                                <MessageSquare size={40} className="text-primary-foreground" />
                                <div className="absolute inset-0 rounded-full bg-gradient-primary opacity-20 blur-xl scale-150"></div>
                            </div>
                        </div>
                        
                        <div className="container min-h-fit">
                            <h1 className="text-2xl md:text-2xl lg:text-2xl font-bold bg-gradient-primary bg-clip-text text-transparent mb-3 animate-fade-in tracking-tight">
                                Agentic Chatting
                            </h1>
                            <p className="text-muted-foreground text-sm animate-fade-in leading-relaxed ">
                                Welcome back! Please sign in to continue your AI conversations
                            </p>
                        </div>
                    </div>
                    
                    <div className="space-y-8">
                        <div className="animate-fade-in space-y-2">
                            <label className="block text-sm font-semibold mb-3 text-foreground/90">Username</label>
                            <Input
                                type="text"
                                value={username}
                                onChange={(e) => onUsernameChange(e.target.value)}
                                placeholder="Enter your username"
                                className="w-full h-14 bg-background/80 border-2 border-border/40 focus:border-primary/60 focus:ring-4 focus:ring-primary/10 transition-all duration-300 text-sm rounded-xl backdrop-blur-sm hover:border-border/60"
                                onKeyDown={(e) => e.key === "Enter" && onSubmit()}
                            />
                        </div>
                        
                        <div className="animate-fade-in space-y-2">
                            <label className="block text-sm font-semibold mb-3 text-foreground/90">Password</label>
                            <div className="relative">
                                <Input
                                    type={showPassword ? "text" : "password"}
                                    value={password}
                                    onChange={(e) => onPasswordChange(e.target.value)}
                                    placeholder="Enter your password"
                                    className="w-full h-14 bg-background/80 border-2 border-border/40 focus:border-primary/60 focus:ring-4 focus:ring-primary/10 transition-all duration-300 text-sm rounded-xl backdrop-blur-sm hover:border-border/60 pr-12"
                                    onKeyDown={(e) => e.key === "Enter" && onSubmit()}
                                />
                                {password.trim() && (
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors duration-200"
                                    >
                                        {showPassword ? <VscEyeClosed size={20} /> : <VscEye size={20} />}
                                    </button>
                                )}
                            </div>
                        </div>
                        
                        <Button
                            onClick={onSubmit}
                            className="w-full h-[3rem] bg-gradient-primary hover:opacity-95 text-primary-foreground font-semibold text-md transition-all duration-300 hover:scale-[1.03] active:scale-[0.98] shadow-2xl hover:shadow-glow animate-fade-in rounded-xl relative overflow-hidden"
                        >
                            <span className="relative z-10">Sign In</span>
                            <div className="absolute inset-0 bg-gradient-to-r from-primary/0 via-primary-foreground/10 to-primary/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000"></div>
                        </Button>
                    </div>
                </div>
            </Card>
        </div>
    );
}
