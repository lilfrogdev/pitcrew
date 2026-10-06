import { betterAuth } from "better-auth";
import { authOptions } from "./src/auth-options";

// Schema generation only: `auth generate --adapter drizzle --dialect sqlite`.
// The Worker builds the runtime instance from these same options and D1.
export const auth = betterAuth(authOptions);
