import { motion, useReducedMotion } from "framer-motion";
import { Cookie } from "lucide-react";
import { Link } from "react-router-dom";
import { saveCookieConsent } from "@/lib/cookieConsentStorage";

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1];

interface CookieConsentBannerProps {
    onAccept: () => void;
}

export function CookieConsentBanner({ onAccept }: CookieConsentBannerProps) {
    const shouldReduce = useReducedMotion();

    const handleAccept = () => {
        saveCookieConsent();
        onAccept();
    };

    return (
        <motion.div
            initial={shouldReduce ? { opacity: 0 } : { height: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            transition={{ duration: 0.52, ease, delay: shouldReduce ? 0 : 0.3 }}
            className="shrink-0 overflow-hidden border-t border-border"
        >
            <motion.div
                initial={shouldReduce ? {} : { y: 18, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.4, delay: shouldReduce ? 0 : 0.48, ease }}
                className="bg-card/95 px-6 py-5 backdrop-blur-md sm:px-8 sm:py-6"
            >
                <div className="mx-auto flex max-w-4xl flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
                    <div className="flex items-start gap-3 sm:items-center">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Cookie size={17} />
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-semibold text-foreground">Privacy Notice</p>
                            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                                mAgenticX uses strictly necessary session cookies for authentication and security — no
                                tracking or ads. By continuing you agree to our{" "}
                                <Link
                                    to="/privacy"
                                    className="font-semibold text-primary underline-offset-2 hover:underline"
                                >
                                    Privacy Policy
                                </Link>{" "}
                                and{" "}
                                <Link
                                    to="/terms"
                                    className="font-semibold text-primary underline-offset-2 hover:underline"
                                >
                                    Terms & Conditions
                                </Link>
                                .
                            </p>
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={handleAccept}
                        className="shrink-0 rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:ml-auto"
                    >
                        Accept & Continue
                    </button>
                </div>
            </motion.div>
        </motion.div>
    );
}
