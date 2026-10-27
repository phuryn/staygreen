export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      agent_activity: {
        Row: {
          actor: string
          client: string
          created_at: string
          id: string
          resource_id: string
          tool: string
          workspace_id: string
        }
        Insert: {
          actor: string
          client: string
          created_at?: string
          id?: string
          resource_id: string
          tool: string
          workspace_id: string
        }
        Update: {
          actor?: string
          client?: string
          created_at?: string
          id?: string
          resource_id?: string
          tool?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_activity_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_budgets: {
        Row: {
          key: string
          started_at: string
          used: number
        }
        Insert: {
          key: string
          started_at: string
          used: number
        }
        Update: {
          key?: string
          started_at?: string
          used?: number
        }
        Relationships: []
      }
      agent_calls: {
        Row: {
          actor: string | null
          auth: string
          client: string | null
          created_at: string
          duration_ms: number
          id: string
          method: string
          outcome: string
          shape: Json | null
          source: string
          status: number
          tool: string | null
          workspace_id: string | null
        }
        Insert: {
          actor?: string | null
          auth: string
          client?: string | null
          created_at?: string
          duration_ms: number
          id?: string
          method: string
          outcome: string
          shape?: Json | null
          source: string
          status: number
          tool?: string | null
          workspace_id?: string | null
        }
        Update: {
          actor?: string | null
          auth?: string
          client?: string | null
          created_at?: string
          duration_ms?: number
          id?: string
          method?: string
          outcome?: string
          shape?: Json | null
          source?: string
          status?: number
          tool?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_calls_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_requests: {
        Row: {
          actor: string
          created_at: string
          input_hash: string
          request_id: string
          result: Json
          tool: string
          workspace_id: string
        }
        Insert: {
          actor: string
          created_at?: string
          input_hash: string
          request_id: string
          result: Json
          tool: string
          workspace_id: string
        }
        Update: {
          actor?: string
          created_at?: string
          input_hash?: string
          request_id?: string
          result?: Json
          tool?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_channels: {
        Row: {
          address: string | null
          audience: string | null
          chat_id: number | null
          confirm_hash: string | null
          confirm_sent_at: string | null
          confirmed_at: string | null
          created_at: string
          created_by: string | null
          id: string
          kind: string
          label: string | null
          sealed: string | null
          unsubscribed_at: string | null
          workspace_id: string
        }
        Insert: {
          address?: string | null
          audience?: string | null
          chat_id?: number | null
          confirm_hash?: string | null
          confirm_sent_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          label?: string | null
          sealed?: string | null
          unsubscribed_at?: string | null
          workspace_id: string
        }
        Update: {
          address?: string | null
          audience?: string | null
          chat_id?: number | null
          confirm_hash?: string | null
          confirm_sent_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          label?: string | null
          sealed?: string | null
          unsubscribed_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_channels_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_deliveries: {
        Row: {
          attempts: number
          channel_id: string | null
          claim: string | null
          claimed_at: string | null
          created_at: string
          detail: string | null
          event: string
          event_id: string
          id: string
          incident_id: string | null
          next_at: string
          provider_id: string | null
          recipient: string
          redirected: boolean
          sent_at: string | null
          status: string
          webhook_attempts: number
          webhook_body: string | null
          webhook_started_at: string | null
          workspace_id: string
        }
        Insert: {
          attempts?: number
          channel_id?: string | null
          claim?: string | null
          claimed_at?: string | null
          created_at?: string
          detail?: string | null
          event: string
          event_id: string
          id?: string
          incident_id?: string | null
          next_at?: string
          provider_id?: string | null
          recipient: string
          redirected?: boolean
          sent_at?: string | null
          status?: string
          webhook_attempts?: number
          webhook_body?: string | null
          webhook_started_at?: string | null
          workspace_id: string
        }
        Update: {
          attempts?: number
          channel_id?: string | null
          claim?: string | null
          claimed_at?: string | null
          created_at?: string
          detail?: string | null
          event?: string
          event_id?: string
          id?: string
          incident_id?: string | null
          next_at?: string
          provider_id?: string | null
          recipient?: string
          redirected?: boolean
          sent_at?: string | null
          status?: string
          webhook_attempts?: number
          webhook_body?: string | null
          webhook_started_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_deliveries_channel_id_workspace_id_fkey"
            columns: ["channel_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "alert_channels"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "alert_deliveries_event_id_workspace_id_fkey"
            columns: ["event_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "alert_events"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      alert_events: {
        Row: {
          channel_id: string | null
          created_at: string
          expanded_at: string | null
          id: string
          incident_id: string | null
          kind: string
          requested_by: string | null
          state_after: string | null
          workspace_id: string
        }
        Insert: {
          channel_id?: string | null
          created_at?: string
          expanded_at?: string | null
          id?: string
          incident_id?: string | null
          kind: string
          requested_by?: string | null
          state_after?: string | null
          workspace_id: string
        }
        Update: {
          channel_id?: string | null
          created_at?: string
          expanded_at?: string | null
          id?: string
          incident_id?: string | null
          kind?: string
          requested_by?: string | null
          state_after?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_events_channel_id_workspace_id_fkey"
            columns: ["channel_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "alert_channels"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "alert_events_incident_id_workspace_id_fkey"
            columns: ["incident_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "alert_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_exclusions: {
        Row: {
          app_id: string
          channel_id: string
          workspace_id: string
        }
        Insert: {
          app_id: string
          channel_id: string
          workspace_id: string
        }
        Update: {
          app_id?: string
          channel_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_exclusions_app_id_workspace_id_fkey"
            columns: ["app_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "alert_exclusions_channel_id_workspace_id_fkey"
            columns: ["channel_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "alert_channels"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      alert_route_channels: {
        Row: {
          channel_id: string
          route_id: string
          workspace_id: string
        }
        Insert: {
          channel_id: string
          route_id: string
          workspace_id: string
        }
        Update: {
          channel_id?: string
          route_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_route_channels_channel_id_workspace_id_fkey"
            columns: ["channel_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "alert_channels"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "alert_route_channels_route_id_workspace_id_fkey"
            columns: ["route_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "alert_routes"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      alert_routes: {
        Row: {
          app_id: string
          id: string
          monitor_id: string | null
          severity: string
          workspace_id: string
        }
        Insert: {
          app_id: string
          id?: string
          monitor_id?: string | null
          severity: string
          workspace_id: string
        }
        Update: {
          app_id?: string
          id?: string
          monitor_id?: string | null
          severity?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_routes_app_id_workspace_id_fkey"
            columns: ["app_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "alert_routes_monitor_app"
            columns: ["monitor_id", "app_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id", "app_id", "workspace_id"]
          },
          {
            foreignKeyName: "alert_routes_monitor_id_workspace_id_fkey"
            columns: ["monitor_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "alert_routes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_suppressions: {
        Row: {
          channel_id: string
          created_at: string
          recipient: string
          workspace_id: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          recipient: string
          workspace_id: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          recipient?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_suppressions_channel_id_workspace_id_fkey"
            columns: ["channel_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "alert_channels"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      api_tokens: {
        Row: {
          created_at: string
          hash: string
          id: string
          kid: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          scope: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          hash: string
          id?: string
          kid: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          scope: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          hash?: string
          id?: string
          kid?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          scope?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_tokens_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      app_logos: {
        Row: {
          app_id: string
          content: string
          created_at: string
          favicon_content: string | null
          favicon_mime: string | null
          id: string
          mime: string
          workspace_id: string
        }
        Insert: {
          app_id: string
          content: string
          created_at?: string
          favicon_content?: string | null
          favicon_mime?: string | null
          id: string
          mime: string
          workspace_id: string
        }
        Update: {
          app_id?: string
          content?: string
          created_at?: string
          favicon_content?: string | null
          favicon_mime?: string | null
          id?: string
          mime?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_logos_app_id_workspace_id_fkey"
            columns: ["app_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      apps: {
        Row: {
          accent: string | null
          created_at: string
          id: string
          name: string
          url: string | null
          workspace_id: string
        }
        Insert: {
          accent?: string | null
          created_at?: string
          id?: string
          name: string
          url?: string | null
          workspace_id: string
        }
        Update: {
          accent?: string | null
          created_at?: string
          id?: string
          name?: string
          url?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "apps_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      budgets: {
        Row: {
          action: string
          actor: string
          used: number
          window_started_at: string
          workspace_id: string
        }
        Insert: {
          action: string
          actor: string
          used: number
          window_started_at: string
          workspace_id: string
        }
        Update: {
          action?: string
          actor?: string
          used?: number
          window_started_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "budgets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      check_failures: {
        Row: {
          at: string
          detail: Json | null
          id: number
          kind: string
          location: string
          message: string
          monitor_id: string
          ms: number
          snippet: string | null
          status: number | null
        }
        Insert: {
          at: string
          detail?: Json | null
          id?: never
          kind: string
          location: string
          message: string
          monitor_id: string
          ms: number
          snippet?: string | null
          status?: number | null
        }
        Update: {
          at?: string
          detail?: Json | null
          id?: never
          kind?: string
          location?: string
          message?: string
          monitor_id?: string
          ms?: number
          snippet?: string | null
          status?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "check_failures_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id"]
          },
        ]
      }
      component_monitors: {
        Row: {
          component_id: string
          monitor_id: string
          workspace_id: string
        }
        Insert: {
          component_id: string
          monitor_id: string
          workspace_id: string
        }
        Update: {
          component_id?: string
          monitor_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "component_monitors_component_id_workspace_id_fkey"
            columns: ["component_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "page_components"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "component_monitors_monitor_id_workspace_id_fkey"
            columns: ["monitor_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      domain_registrations: {
        Row: {
          attempted_at: string
          checked_at: string | null
          error: string | null
          expires_at: string | null
          name: string
          registrar: string | null
          status: string
        }
        Insert: {
          attempted_at: string
          checked_at?: string | null
          error?: string | null
          expires_at?: string | null
          name: string
          registrar?: string | null
          status: string
        }
        Update: {
          attempted_at?: string
          checked_at?: string | null
          error?: string | null
          expires_at?: string | null
          name?: string
          registrar?: string | null
          status?: string
        }
        Relationships: []
      }
      heartbeat_latest: {
        Row: {
          fail_at: string | null
          fail_note: string | null
          fail_payload: Json | null
          finishes: number
          judged_at: string | null
          judged_finishes: number
          monitor_id: string
          ping_at: string | null
          ping_note: string | null
          ping_payload: Json | null
          rate_fail: number
          rate_minute: string
          rate_ping: number
          rate_start: number
          run_at: string | null
          start_at: string | null
          start_note: string | null
          start_payload: Json | null
          workspace_id: string
        }
        Insert: {
          fail_at?: string | null
          fail_note?: string | null
          fail_payload?: Json | null
          finishes?: number
          judged_at?: string | null
          judged_finishes?: number
          monitor_id: string
          ping_at?: string | null
          ping_note?: string | null
          ping_payload?: Json | null
          rate_fail?: number
          rate_minute: string
          rate_ping?: number
          rate_start?: number
          run_at?: string | null
          start_at?: string | null
          start_note?: string | null
          start_payload?: Json | null
          workspace_id: string
        }
        Update: {
          fail_at?: string | null
          fail_note?: string | null
          fail_payload?: Json | null
          finishes?: number
          judged_at?: string | null
          judged_finishes?: number
          monitor_id?: string
          ping_at?: string | null
          ping_note?: string | null
          ping_payload?: Json | null
          rate_fail?: number
          rate_minute?: string
          rate_ping?: number
          rate_start?: number
          run_at?: string | null
          start_at?: string | null
          start_note?: string | null
          start_payload?: Json | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "heartbeat_latest_monitor_fkey"
            columns: ["monitor_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      incident_notes: {
        Row: {
          author_client: string | null
          author_user_id: string | null
          body: string
          created_at: string
          id: string
          incident_id: string
          published_at: string | null
          state: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          author_client?: string | null
          author_user_id?: string | null
          body: string
          created_at?: string
          id?: string
          incident_id: string
          published_at?: string | null
          state: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          author_client?: string | null
          author_user_id?: string | null
          body?: string
          created_at?: string
          id?: string
          incident_id?: string
          published_at?: string | null
          state?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "incident_notes_incident_id_workspace_id_fkey"
            columns: ["incident_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      incidents: {
        Row: {
          acked_at: string | null
          evidence: Json
          id: string
          monitor_id: string
          opened_at: string
          resolved_at: string | null
          severity: string
          timeline: Json
          title: string
          workspace_id: string
        }
        Insert: {
          acked_at?: string | null
          evidence?: Json
          id?: string
          monitor_id: string
          opened_at?: string
          resolved_at?: string | null
          severity: string
          timeline?: Json
          title: string
          workspace_id: string
        }
        Update: {
          acked_at?: string | null
          evidence?: Json
          id?: string
          monitor_id?: string
          opened_at?: string
          resolved_at?: string | null
          severity?: string
          timeline?: Json
          title?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "incidents_monitor_id_workspace_id_fkey"
            columns: ["monitor_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      monitor_secrets: {
        Row: {
          created_at: string
          monitor_id: string
          name: string
          sealed: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          monitor_id: string
          name: string
          sealed: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          monitor_id?: string
          name?: string
          sealed?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "monitor_secrets_monitor_id_workspace_id_fkey"
            columns: ["monitor_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      monitors: {
        Row: {
          app_id: string
          auto: boolean
          cert_expires_at: string | null
          cert_host: string | null
          cert_issuer: string | null
          config: Json
          created_at: string
          heartbeat_token_hash: string | null
          heartbeat_token_sealed: string | null
          id: string
          interval_sec: number
          name: string
          pause_reason: string | null
          paused_at: string | null
          paused_until: string | null
          probe_fail_streak: number
          probe_outcome_at: string | null
          probe_outcome_locations: string[]
          probe_pass_streak: number
          probe_slow_streak: number
          service_runtime: Json
          state: string | null
          state_since: string | null
          target: string
          target_host: string | null
          type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          app_id: string
          auto?: boolean
          cert_expires_at?: string | null
          cert_host?: string | null
          cert_issuer?: string | null
          config?: Json
          created_at?: string
          heartbeat_token_hash?: string | null
          heartbeat_token_sealed?: string | null
          id?: string
          interval_sec: number
          name: string
          pause_reason?: string | null
          paused_at?: string | null
          paused_until?: string | null
          probe_fail_streak?: number
          probe_outcome_at?: string | null
          probe_outcome_locations?: string[]
          probe_pass_streak?: number
          probe_slow_streak?: number
          service_runtime?: Json
          state?: string | null
          state_since?: string | null
          target: string
          target_host?: string | null
          type: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          app_id?: string
          auto?: boolean
          cert_expires_at?: string | null
          cert_host?: string | null
          cert_issuer?: string | null
          config?: Json
          created_at?: string
          heartbeat_token_hash?: string | null
          heartbeat_token_sealed?: string | null
          id?: string
          interval_sec?: number
          name?: string
          pause_reason?: string | null
          paused_at?: string | null
          paused_until?: string | null
          probe_fail_streak?: number
          probe_outcome_at?: string | null
          probe_outcome_locations?: string[]
          probe_pass_streak?: number
          probe_slow_streak?: number
          service_runtime?: Json
          state?: string | null
          state_since?: string | null
          target?: string
          target_host?: string | null
          type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "monitors_app_id_workspace_id_fkey"
            columns: ["app_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "monitors_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      page_assets: {
        Row: {
          content: string
          id: string
          kind: string
          mime: string
          page_id: string
          workspace_id: string
        }
        Insert: {
          content: string
          id: string
          kind: string
          mime: string
          page_id: string
          workspace_id: string
        }
        Update: {
          content?: string
          id?: string
          kind?: string
          mime?: string
          page_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "page_assets_page_id_workspace_id_fkey"
            columns: ["page_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "status_pages"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      page_components: {
        Row: {
          id: string
          in_app: boolean
          name: string
          page_id: string
          position: number
          workspace_id: string
        }
        Insert: {
          id?: string
          in_app?: boolean
          name: string
          page_id: string
          position: number
          workspace_id: string
        }
        Update: {
          id?: string
          in_app?: boolean
          name?: string
          page_id?: string
          position?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "page_components_page_id_workspace_id_fkey"
            columns: ["page_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "status_pages"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      page_domains: {
        Row: {
          cname_target: string
          created_at: string
          host: string
          monitor_id: string | null
          page_id: string
          verified_at: string | null
          workspace_id: string
        }
        Insert: {
          cname_target?: string
          created_at?: string
          host: string
          monitor_id?: string | null
          page_id: string
          verified_at?: string | null
          workspace_id: string
        }
        Update: {
          cname_target?: string
          created_at?: string
          host?: string
          monitor_id?: string | null
          page_id?: string
          verified_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "page_domains_monitor_id_workspace_id_fkey"
            columns: ["monitor_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "page_domains_page_id_workspace_id_fkey"
            columns: ["page_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "status_pages"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      probe_flush_receipts: {
        Row: {
          flushed_at: string
          probe_id: string
        }
        Insert: {
          flushed_at: string
          probe_id: string
        }
        Update: {
          flushed_at?: string
          probe_id?: string
        }
        Relationships: []
      }
      probes: {
        Row: {
          builder_only: boolean
          id: string
          last_seen: string
          location: string
          url: string
        }
        Insert: {
          builder_only?: boolean
          id: string
          last_seen?: string
          location: string
          url: string
        }
        Update: {
          builder_only?: boolean
          id?: string
          last_seen?: string
          location?: string
          url?: string
        }
        Relationships: []
      }
      response_rollups: {
        Row: {
          bucket: string
          location: string
          monitor_id: string
          p50_ms: number | null
          p95_ms: number | null
          resolution: string
        }
        Insert: {
          bucket: string
          location: string
          monitor_id: string
          p50_ms?: number | null
          p95_ms?: number | null
          resolution: string
        }
        Update: {
          bucket?: string
          location?: string
          monitor_id?: string
          p50_ms?: number | null
          p95_ms?: number | null
          resolution?: string
        }
        Relationships: [
          {
            foreignKeyName: "response_rollups_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id"]
          },
        ]
      }
      rollups_1d: {
        Row: {
          checks: number
          day: string
          failures: number
          monitor_id: string
          windows: number
        }
        Insert: {
          checks?: number
          day: string
          failures?: number
          monitor_id: string
          windows?: number
        }
        Update: {
          checks?: number
          day?: string
          failures?: number
          monitor_id?: string
          windows?: number
        }
        Relationships: [
          {
            foreignKeyName: "rollups_1d_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id"]
          },
        ]
      }
      rollups_5m: {
        Row: {
          checks: number
          failures: number
          location: string
          max_ms: number | null
          monitor_id: string
          p50_ms: number | null
          p95_ms: number | null
          window_start: string
        }
        Insert: {
          checks: number
          failures: number
          location: string
          max_ms?: number | null
          monitor_id: string
          p50_ms?: number | null
          p95_ms?: number | null
          window_start: string
        }
        Update: {
          checks?: number
          failures?: number
          location?: string
          max_ms?: number | null
          monitor_id?: string
          p50_ms?: number | null
          p95_ms?: number | null
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "rollups_5m_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id"]
          },
        ]
      }
      scan_budgets: {
        Row: {
          expires_at: string
          key: string
          used: number
        }
        Insert: {
          expires_at: string
          key: string
          used: number
        }
        Update: {
          expires_at?: string
          key?: string
          used?: number
        }
        Relationships: []
      }
      slack_installs: {
        Row: {
          created_at: string
          state_hash: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          state_hash: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          state_hash?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "slack_installs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      status_pages: {
        Row: {
          accent: string
          app_id: string
          created_at: string
          edge_withdrawn: boolean
          history_days: number
          homepage: string | null
          id: string
          logo_text: string
          members_only: boolean
          name: string
          noindex: boolean
          powered_by: boolean
          slug: string
          theme: string
          updated_at: string
          visibility_version: number
          workspace_id: string
        }
        Insert: {
          accent?: string
          app_id: string
          created_at?: string
          edge_withdrawn?: boolean
          history_days?: number
          homepage?: string | null
          id?: string
          logo_text?: string
          members_only?: boolean
          name: string
          noindex?: boolean
          powered_by?: boolean
          slug: string
          theme?: string
          updated_at?: string
          visibility_version?: number
          workspace_id: string
        }
        Update: {
          accent?: string
          app_id?: string
          created_at?: string
          edge_withdrawn?: boolean
          history_days?: number
          homepage?: string | null
          id?: string
          logo_text?: string
          members_only?: boolean
          name?: string
          noindex?: boolean
          powered_by?: boolean
          slug?: string
          theme?: string
          updated_at?: string
          visibility_version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "status_pages_app_id_workspace_id_fkey"
            columns: ["app_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      transitions: {
        Row: {
          at: string
          from_state: string | null
          id: number
          monitor_id: string
          to_state: string
        }
        Insert: {
          at: string
          from_state?: string | null
          id?: never
          monitor_id: string
          to_state: string
        }
        Update: {
          at?: string
          from_state?: string | null
          id?: never
          monitor_id?: string
          to_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "transitions_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          clerk_org_id: string
          created_at: string
          id: string
          plan: string
        }
        Insert: {
          clerk_org_id: string
          created_at?: string
          id?: string
          plan?: string
        }
        Update: {
          clerk_org_id?: string
          created_at?: string
          id?: string
          plan?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ack_incident: {
        Args: { p_incident_id: string; p_via: string; p_workspace_id: string }
        Returns: {
          acked_at: string | null
          evidence: Json
          id: string
          monitor_id: string
          opened_at: string
          resolved_at: string | null
          severity: string
          timeline: Json
          title: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "incidents"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admit_scan: { Args: { p_key: string }; Returns: number }
      agent_budget: {
        Args: { p_key: string; p_limit: number }
        Returns: number
      }
      agent_check_times: { Args: { p_workspace_id: string }; Returns: Json }
      agent_create_monitor: {
        Args: {
          p_app_id: string
          p_limits: Json
          p_row: Json
          p_workspace_id: string
        }
        Returns: string
      }
      agent_history: {
        Args: {
          p_after: string
          p_days: number
          p_limit: number
          p_monitor_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      agent_published_notes: {
        Args: { p_incident_ids: string[]; p_workspace_id: string }
        Returns: Json
      }
      agent_response_times: {
        Args: {
          p_days: number
          p_limit: number
          p_location: string
          p_monitor_id: string
          p_offset: number
          p_workspace_id: string
        }
        Returns: Json
      }
      agent_token_create: {
        Args: {
          p_hash: string
          p_id: string
          p_kid: string
          p_name: string
          p_scope: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      agent_write: {
        Args: {
          p_actor: string
          p_client: string
          p_input_hash: string
          p_limits: Json
          p_payload: Json
          p_request_id: string
          p_scope: string
          p_tool: string
          p_workspace_id: string
        }
        Returns: Json
      }
      alert_claim: {
        Args: {
          p_claim: string
          p_event_id: string
          p_lease_sec: number
          p_limit: number
        }
        Returns: Json
      }
      alert_claim_channels: {
        Args: {
          p_claim: string
          p_event_id: string
          p_lease_sec: number
          p_limit: number
        }
        Returns: Json
      }
      alert_expand: {
        Args: { p_event_id: string; p_members: string[] }
        Returns: Json
      }
      alert_mark: {
        Args: {
          p_claim: string
          p_detail: string
          p_id: string
          p_provider_id: string
          p_redirected: boolean
          p_retry_sec: number
          p_status: string
        }
        Returns: boolean
      }
      alert_overview: {
        Args: { p_limit: number; p_workspace_id: string }
        Returns: Json
      }
      alert_pending_events: {
        Args: { p_event_id: string; p_limit: number }
        Returns: Json
      }
      alert_prepare_webhook: {
        Args: { p_body: string; p_claim: string; p_id: string }
        Returns: Json
      }
      alert_route_matches: {
        Args: { p_channel_id: string; p_incident_id: string }
        Returns: boolean
      }
      alert_unsubscribe: { Args: { p_delivery_id: string }; Returns: Json }
      begin_private_page: {
        Args: {
          p_page_id: string
          p_private_pages: boolean
          p_workspace_id: string
        }
        Returns: Json
      }
      bind_telegram_chat: {
        Args: {
          p_chat_id: number
          p_code_hash: string
          p_label: string
          p_max_age_sec: number
        }
        Returns: Json
      }
      confirm_alert_address: {
        Args: { p_confirm_hash: string; p_max_age_sec: number }
        Returns: Json
      }
      consume_slack_install: {
        Args: { p_hash: string; p_user_id: string; p_workspace_id: string }
        Returns: boolean
      }
      create_alert_address: {
        Args: {
          p_address: string
          p_confirm_hash: string
          p_created_by: string
          p_notify_teammates: boolean
          p_workspace_id: string
        }
        Returns: {
          address: string | null
          audience: string | null
          chat_id: number | null
          confirm_hash: string | null
          confirm_sent_at: string | null
          confirmed_at: string | null
          created_at: string
          created_by: string | null
          id: string
          kind: string
          label: string | null
          sealed: string | null
          unsubscribed_at: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "alert_channels"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_app: {
        Args: {
          p_max_apps: number
          p_name: string
          p_url: string
          p_workspace_id: string
        }
        Returns: {
          accent: string | null
          created_at: string
          id: string
          name: string
          url: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "apps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_monitor: {
        Args: {
          p_app_id: string
          p_config: Json
          p_heartbeat_token_hash: string
          p_heartbeat_token_sealed?: string
          p_id: string
          p_interval_sec: number
          p_max_assertions: number
          p_max_heartbeat_assertions: number
          p_max_heartbeats: number
          p_max_monitors: number
          p_min_interval_sec: number
          p_name: string
          p_per_host: number
          p_secrets: Json
          p_target: string
          p_target_host: string
          p_type: string
          p_workspace_id: string
        }
        Returns: {
          app_id: string
          auto: boolean
          cert_expires_at: string | null
          cert_host: string | null
          cert_issuer: string | null
          config: Json
          created_at: string
          heartbeat_token_hash: string | null
          heartbeat_token_sealed: string | null
          id: string
          interval_sec: number
          name: string
          pause_reason: string | null
          paused_at: string | null
          paused_until: string | null
          probe_fail_streak: number
          probe_outcome_at: string | null
          probe_outcome_locations: string[]
          probe_pass_streak: number
          probe_slow_streak: number
          service_runtime: Json
          state: string | null
          state_since: string | null
          target: string
          target_host: string | null
          type: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "monitors"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_status_page: {
        Args: {
          p_app_id: string
          p_homepage: string
          p_logo_text: string
          p_max_pages: number
          p_name: string
          p_slug: string
          p_workspace_id: string
        }
        Returns: {
          accent: string
          app_id: string
          created_at: string
          edge_withdrawn: boolean
          history_days: number
          homepage: string | null
          id: string
          logo_text: string
          members_only: boolean
          name: string
          noindex: boolean
          powered_by: boolean
          slug: string
          theme: string
          updated_at: string
          visibility_version: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "status_pages"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_telegram_link: {
        Args: {
          p_code_hash: string
          p_created_by: string
          p_workspace_id: string
        }
        Returns: string
      }
      delete_app: {
        Args: { p_app_id: string; p_workspace_id: string }
        Returns: undefined
      }
      delete_monitor: {
        Args: { p_monitor_id: string; p_workspace_id: string }
        Returns: undefined
      }
      domain_registration_for: {
        Args: { p_hosts: string[] }
        Returns: {
          attempted_at: string
          checked_at: string
          error: string
          expires_at: string
          host: string
          name: string
          registrar: string
          status: string
        }[]
      }
      edge_domain_allowed: { Args: { p_host: string }; Returns: boolean }
      ensure_workspace: {
        Args: { p_clerk_org_id: string }
        Returns: {
          clerk_org_id: string
          created_at: string
          id: string
          plan: string
        }
        SetofOptions: {
          from: "*"
          to: "workspaces"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      monitor_days: {
        Args: { p_days: number; p_monitor_ids: string[] }
        Returns: {
          covered: number
          day: string
          down: number
          monitor_id: string
          up: number
        }[]
      }
      monitor_history: {
        Args: { p_monitor_id: string; p_workspace_id: string }
        Returns: Json
      }
      monitor_target_host: {
        Args: { p_target: string; p_type: string }
        Returns: string
      }
      new_id: { Args: { p_prefix: string }; Returns: string }
      pause_monitor: {
        Args: {
          p_minutes: number
          p_monitor_id: string
          p_reason: string
          p_workspace_id: string
        }
        Returns: {
          app_id: string
          auto: boolean
          cert_expires_at: string | null
          cert_host: string | null
          cert_issuer: string | null
          config: Json
          created_at: string
          heartbeat_token_hash: string | null
          heartbeat_token_sealed: string | null
          id: string
          interval_sec: number
          name: string
          pause_reason: string | null
          paused_at: string | null
          paused_until: string | null
          probe_fail_streak: number
          probe_outcome_at: string | null
          probe_outcome_locations: string[]
          probe_pass_streak: number
          probe_slow_streak: number
          service_runtime: Json
          state: string | null
          state_since: string | null
          target: string
          target_host: string | null
          type: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "monitors"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      probe_builder_workspaces: {
        Args: { p_workspaces: string[] }
        Returns: {
          workspace_id: string
        }[]
      }
      probe_commit_heartbeat: {
        Args: {
          p_at: string
          p_effects: Json
          p_from: string
          p_id: string
          p_judged_at: string
          p_judged_finishes: number
          p_run_at: string
          p_state: string
          p_version: string
        }
        Returns: undefined
      }
      probe_commit_monitor: {
        Args: {
          p_at: string
          p_effects: Json
          p_fail: number
          p_id: string
          p_locations: string[]
          p_pass: number
          p_slow: number
          p_state: string
          p_version: string
        }
        Returns: undefined
      }
      probe_flush_rollups: {
        Args: {
          p_checks: number[]
          p_failures: number[]
          p_locations: string[]
          p_max: number[]
          p_monitors: string[]
          p_p50: number[]
          p_p95: number[]
          p_windows: string[]
        }
        Returns: undefined
      }
      probe_flush_with_receipt: {
        Args: {
          p_checks: number[]
          p_failures: number[]
          p_id: string
          p_locations: string[]
          p_max: number[]
          p_monitors: string[]
          p_p50: number[]
          p_p95: number[]
          p_windows: string[]
        }
        Returns: undefined
      }
      probe_heartbeat: {
        Args: {
          p_builder_only: boolean
          p_id: string
          p_location: string
          p_url: string
        }
        Returns: undefined
      }
      probe_leave: { Args: { p_id: string }; Returns: undefined }
      probe_live: {
        Args: never
        Returns: {
          builder_only: boolean
          id: string
          location: string
          url: string
        }[]
      }
      probe_load_domains: {
        Args: { p_hosts: string[] }
        Returns: {
          attempted_at: number
          error: string
          host: string
          name: string
          status: string
        }[]
      }
      probe_load_heartbeats: {
        Args: { p_workspaces: string[] }
        Returns: {
          config: Json
          fail_at: number
          finishes: number
          id: string
          judged_at: number
          judged_finishes: number
          paused: boolean
          ping_at: number
          run_at: number
          start_at: number
          state: string
          version: string
          version_at: number
          workspace_id: string
        }[]
      }
      probe_load_monitors: {
        Args: { p_workspaces: string[] }
        Returns: {
          config: Json
          id: string
          interval_sec: number
          name: string
          paused: boolean
          secrets: Json
          target: string
          type: string
          unchecked: boolean
          version: string
          workspace_id: string
        }[]
      }
      probe_load_service_monitors: {
        Args: { p_workspaces: string[] }
        Returns: {
          config: Json
          id: string
          interval_sec: number
          name: string
          paused: boolean
          secrets: Json
          target: string
          type: string
          unchecked: boolean
          version: string
          workspace_id: string
        }[]
      }
      probe_lock_heartbeat: {
        Args: { p_id: string }
        Returns: {
          config: Json
          db_now: number
          fail_at: number
          fail_note: string
          fail_payload: Json
          finishes: number
          id: string
          judged_at: number
          judged_finishes: number
          name: string
          paused: boolean
          ping_at: number
          ping_note: string
          ping_payload: Json
          run_at: number
          start_at: number
          start_note: string
          start_payload: Json
          state: string
          version: string
          version_at: number
          workspace_id: string
        }[]
      }
      probe_lock_monitor: {
        Args: { p_id: string }
        Returns: {
          cert_expires_at: number
          cert_host: string
          cert_issuer: string
          config: Json
          id: string
          name: string
          outcome_at: number
          paused: boolean
          probe_fail_streak: number
          probe_outcome_locations: string[]
          probe_pass_streak: number
          probe_slow_streak: number
          since: number
          state: string
          target: string
          target_host: string
          type: string
          version: string
          workspace_id: string
        }[]
      }
      probe_record_domain: {
        Args: {
          p_error: string
          p_expires_at: string
          p_host: string
          p_name: string
          p_registrar: string
          p_status: string
        }
        Returns: boolean
      }
      public_incident: { Args: { p_incident_id: string }; Returns: Json }
      public_status_snapshot: { Args: { p_slug: string }; Returns: Json }
      record_heartbeat: {
        Args: {
          p_kind: string
          p_note: string
          p_payload: Json
          p_token_hash: string
        }
        Returns: string
      }
      reserve_page_domain: {
        Args: { p_cname_target?: string; p_host: string; p_page_id: string; p_workspace_id: string }
        Returns: {
          cname_target: string
          created_at: string
          host: string
          monitor_id: string | null
          page_id: string
          verified_at: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "page_domains"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      resume_monitor: {
        Args: { p_monitor_id: string; p_workspace_id: string }
        Returns: {
          app_id: string
          auto: boolean
          cert_expires_at: string | null
          cert_host: string | null
          cert_issuer: string | null
          config: Json
          created_at: string
          heartbeat_token_hash: string | null
          heartbeat_token_sealed: string | null
          id: string
          interval_sec: number
          name: string
          pause_reason: string | null
          paused_at: string | null
          paused_until: string | null
          probe_fail_streak: number
          probe_outcome_at: string | null
          probe_outcome_locations: string[]
          probe_pass_streak: number
          probe_slow_streak: number
          service_runtime: Json
          state: string | null
          state_since: string | null
          target: string
          target_host: string | null
          type: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "monitors"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_incident_note: {
        Args: {
          p_author_client: string
          p_author_user_id: string
          p_body: string
          p_incident_id: string
          p_note_id: string
          p_publish: boolean
          p_state: string
          p_workspace_id: string
        }
        Returns: {
          author_client: string | null
          author_user_id: string | null
          body: string
          created_at: string
          id: string
          incident_id: string
          published_at: string | null
          state: string
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "incident_notes"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_service_monitor: {
        Args: {
          p_app_id: string
          p_config: Json
          p_edit: boolean
          p_id: string
          p_interval_sec: number
          p_max_monitors: number
          p_max_type: number
          p_name: string
          p_per_host: number
          p_sealed: string
          p_target: string
          p_type: string
          p_workspace_id: string
        }
        Returns: string
      }
      save_status_page: {
        Args: {
          p_accent: string
          p_components: Json
          p_history_days: number
          p_homepage: string
          p_logo_text: string
          p_name: string
          p_noindex: boolean
          p_page_id: string
          p_powered_by: boolean
          p_private_pages: boolean
          p_slug: string
          p_theme: string
          p_white_label: boolean
          p_workspace_id: string
        }
        Returns: {
          accent: string
          app_id: string
          created_at: string
          edge_withdrawn: boolean
          history_days: number
          homepage: string | null
          id: string
          logo_text: string
          members_only: boolean
          name: string
          noindex: boolean
          powered_by: boolean
          slug: string
          theme: string
          updated_at: string
          visibility_version: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "status_pages"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_status_page_access: {
        Args: {
          p_accent: string
          p_components: Json
          p_history_days: number
          p_homepage: string
          p_logo_text: string
          p_members_only: boolean
          p_name: string
          p_noindex: boolean
          p_page_id: string
          p_powered_by: boolean
          p_private_pages: boolean
          p_slug: string
          p_theme: string
          p_white_label: boolean
          p_withdrawal_version?: number
          p_workspace_id: string
        }
        Returns: {
          accent: string
          app_id: string
          created_at: string
          edge_withdrawn: boolean
          history_days: number
          homepage: string | null
          id: string
          logo_text: string
          members_only: boolean
          name: string
          noindex: boolean
          powered_by: boolean
          slug: string
          theme: string
          updated_at: string
          visibility_version: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "status_pages"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_alert_routing: {
        Args: {
          p_alert_rules: boolean
          p_app_id: string
          p_channels: string[]
          p_monitor_id: string
          p_severity: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      spend_budget: {
        Args: {
          p_action: string
          p_member_limit: number
          p_member_window_sec: number
          p_user_id: string
          p_workspace_id: string
          p_workspace_limit: number
          p_workspace_window_sec: number
        }
        Returns: Json
      }
      status_page_access: {
        Args: { p_incident_id?: string; p_slug: string }
        Returns: Json
      }
      status_page_snapshot: {
        Args: { p_slug: string; p_workspace_id: string }
        Returns: Json
      }
      telegram_stop: { Args: { p_chat_id: number }; Returns: number }
      update_monitor: {
        Args: {
          p_config: Json
          p_interval_sec: number
          p_max_assertions: number
          p_max_heartbeat_assertions: number
          p_min_interval_sec: number
          p_monitor_id: string
          p_name: string
          p_per_host: number
          p_secrets: Json
          p_target: string
          p_target_host: string
          p_workspace_id: string
        }
        Returns: {
          app_id: string
          auto: boolean
          cert_expires_at: string | null
          cert_host: string | null
          cert_issuer: string | null
          config: Json
          created_at: string
          heartbeat_token_hash: string | null
          heartbeat_token_sealed: string | null
          id: string
          interval_sec: number
          name: string
          pause_reason: string | null
          paused_at: string | null
          paused_until: string | null
          probe_fail_streak: number
          probe_outcome_at: string | null
          probe_outcome_locations: string[]
          probe_pass_streak: number
          probe_slow_streak: number
          service_runtime: Json
          state: string | null
          state_since: string | null
          target: string
          target_host: string | null
          type: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "monitors"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      verify_page_domain: {
        Args: {
          p_cname_target: string
          p_created_at: string
          p_host: string
          p_max_monitors: number
          p_max_per_host: number
          p_page_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      watchdog_flush_status: {
        Args: { p_ids: string[] }
        Returns: {
          age_sec: number
          flushed_at: string
          id: string
        }[]
      }
      workspace_domains: {
        Args: { p_workspace_id: string }
        Returns: {
          attempted_at: string
          checked_at: string
          error: string
          expires_at: string
          host: string
          name: string
          registrar: string
          status: string
        }[]
      }
      workspace_history: { Args: { p_workspace_id: string }; Returns: Json }
      workspace_snapshot: { Args: { p_workspace_id: string }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
