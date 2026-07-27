import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "./supabase.client.js";

@Global()
@Module({
  providers: [
    {
      provide: SUPABASE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient(
          config.getOrThrow<string>("SUPABASE_URL"),
          config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY"),
          {
            auth: {
              persistSession: false,
              autoRefreshToken: false
            }
          }
        )
    }
  ],
  exports: [SUPABASE_CLIENT]
})
export class DatabaseModule {}

