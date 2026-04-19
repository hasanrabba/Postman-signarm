import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signarm Signal — API Platform",
  description: "Signarm Signal: design, test, mock, and document APIs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  );
}
