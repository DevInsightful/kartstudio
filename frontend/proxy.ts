import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/login" || pathname === "/setup" || pathname.startsWith("/_next/") || pathname === "/favicon.ico") return NextResponse.next();
  if (!request.cookies.has("kartar_session")) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!api/health).*)"] };
