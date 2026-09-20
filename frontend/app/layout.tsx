import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { LoginGate } from "@/components/LoginGate";

export const metadata: Metadata = {
  title: "Tera Trade",
  description: "Tera Trade trading dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-gray-100">
        <LoginGate>
          <ConfirmProvider>
            <Nav />
            <main className="mx-auto max-w-[1600px] px-6 py-6">{children}</main>
          </ConfirmProvider>
        </LoginGate>
      </body>
    </html>
  );
}
