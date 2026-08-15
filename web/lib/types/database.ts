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
    PostgrestVersion: "14.5"
  }
  core: {
    Tables: {
      integration_credentials: {
        Row: {
          created_at: string
          created_by: string | null
          database_name: string
          db_password_enc: string
          db_user: string
          host: string
          id: string
          integration_name: string
          notes: string | null
          port: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          database_name: string
          db_password_enc: string
          db_user: string
          host: string
          id?: string
          integration_name: string
          notes?: string | null
          port: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          database_name?: string
          db_password_enc?: string
          db_user?: string
          host?: string
          id?: string
          integration_name?: string
          notes?: string | null
          port?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "integration_credentials_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "integration_credentials_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string
          region: string | null
          role: Database["core"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          full_name: string
          region?: string | null
          role: Database["core"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          full_name?: string
          region?: string | null
          role?: Database["core"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      retail_calendar: {
        Row: {
          date: string
          day_name: string
          day_number: number
          financial_year: string
          is_weekend: boolean
          month_end: string
          month_start: string
          prev_retail_week_start: string
          retail_month: number
          retail_month_name: string
          retail_quarter: number
          retail_week: number
          retail_year: number
          same_week_last_year_start: string
          week_end: string
          week_start: string
        }
        Insert: {
          date: string
          day_name: string
          day_number: number
          financial_year: string
          is_weekend: boolean
          month_end: string
          month_start: string
          prev_retail_week_start: string
          retail_month: number
          retail_month_name: string
          retail_quarter: number
          retail_week: number
          retail_year: number
          same_week_last_year_start: string
          week_end: string
          week_start: string
        }
        Update: {
          date?: string
          day_name?: string
          day_number?: number
          financial_year?: string
          is_weekend?: boolean
          month_end?: string
          month_start?: string
          prev_retail_week_start?: string
          retail_month?: number
          retail_month_name?: string
          retail_quarter?: number
          retail_week?: number
          retail_year?: number
          same_week_last_year_start?: string
          week_end?: string
          week_start?: string
        }
        Relationships: []
      }
      stores: {
        Row: {
          branch_name_erp: string
          city: string
          created_at: string
          is_active: boolean
          opened_date: string | null
          region: string
          store_id: string
          store_name: string
          store_type: string
        }
        Insert: {
          branch_name_erp: string
          city: string
          created_at?: string
          is_active?: boolean
          opened_date?: string | null
          region: string
          store_id: string
          store_name: string
          store_type?: string
        }
        Update: {
          branch_name_erp?: string
          city?: string
          created_at?: string
          is_active?: boolean
          opened_date?: string | null
          region?: string
          store_id?: string
          store_name?: string
          store_type?: string
        }
        Relationships: []
      }
      user_store_access: {
        Row: {
          store_id: string
          user_id: string
        }
        Insert: {
          store_id: string
          user_id: string
        }
        Update: {
          store_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_store_access_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "user_store_access_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      fn_decrypt_logic_erp_password: {
        Args: { p_passphrase: string }
        Returns: string
      }
      fn_save_logic_erp_credentials: {
        Args: {
          p_database_name: string
          p_db_password: string
          p_db_user: string
          p_host: string
          p_passphrase: string
          p_port: number
          p_updated_by: string
        }
        Returns: undefined
      }
      fn_user_role: {
        Args: never
        Returns: Database["core"]["Enums"]["app_role"]
      }
      fn_user_store_ids: { Args: never; Returns: string[] }
    }
    Enums: {
      app_role:
        | "super_admin"
        | "ho_admin"
        | "regional_manager"
        | "ebo_manager"
        | "marketing"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  marketing: {
    Tables: {
      campaign_import_batches: {
        Row: {
          column_mapping: Json
          duplicate_count: number
          error_log: Json | null
          failed_count: number
          file_name: string
          id: string
          row_count: number
          status: string
          success_count: number
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          column_mapping: Json
          duplicate_count?: number
          error_log?: Json | null
          failed_count?: number
          file_name: string
          id?: string
          row_count: number
          status?: string
          success_count?: number
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          column_mapping?: Json
          duplicate_count?: number
          error_log?: Json | null
          failed_count?: number
          file_name?: string
          id?: string
          row_count?: number
          status?: string
          success_count?: number
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      campaign_recipients: {
        Row: {
          attempted: boolean
          attributed_order_id: string | null
          attributed_revenue: number | null
          campaign_id: string
          delivered: boolean
          error_code: string | null
          failed: boolean
          failure_reason: string | null
          id: string
          import_batch_id: string | null
          read: boolean
          recipient_name: string | null
          recipient_phone: string
          sent: boolean
          sent_at: string | null
          status_flags_conflict: boolean
        }
        Insert: {
          attempted?: boolean
          attributed_order_id?: string | null
          attributed_revenue?: number | null
          campaign_id: string
          delivered?: boolean
          error_code?: string | null
          failed?: boolean
          failure_reason?: string | null
          id?: string
          import_batch_id?: string | null
          read?: boolean
          recipient_name?: string | null
          recipient_phone: string
          sent?: boolean
          sent_at?: string | null
          status_flags_conflict?: boolean
        }
        Update: {
          attempted?: boolean
          attributed_order_id?: string | null
          attributed_revenue?: number | null
          campaign_id?: string
          delivered?: boolean
          error_code?: string | null
          failed?: boolean
          failure_reason?: string | null
          id?: string
          import_batch_id?: string | null
          read?: boolean
          recipient_name?: string | null
          recipient_phone?: string
          sent?: boolean
          sent_at?: string | null
          status_flags_conflict?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_recipients_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "campaign_import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_stores: {
        Row: {
          campaign_id: string
          store_id: string
        }
        Insert: {
          campaign_id: string
          store_id: string
        }
        Update: {
          campaign_id?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_stores_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          approved_by: string | null
          campaign_date: string
          campaign_name: string
          campaign_status: string
          campaign_type: string | null
          created_at: string
          description: string | null
          external_campaign_id: string | null
          id: string
          import_batch_id: string | null
          offer: string | null
          requested_by: string | null
          template: string | null
          updated_at: string
        }
        Insert: {
          approved_by?: string | null
          campaign_date: string
          campaign_name: string
          campaign_status?: string
          campaign_type?: string | null
          created_at?: string
          description?: string | null
          external_campaign_id?: string | null
          id?: string
          import_batch_id?: string | null
          offer?: string | null
          requested_by?: string | null
          template?: string | null
          updated_at?: string
        }
        Update: {
          approved_by?: string | null
          campaign_date?: string
          campaign_name?: string
          campaign_status?: string
          campaign_type?: string | null
          created_at?: string
          description?: string | null
          external_campaign_id?: string | null
          id?: string
          import_batch_id?: string | null
          offer?: string | null
          requested_by?: string | null
          template?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "campaign_import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      vw_campaign_failure_reasons: {
        Row: {
          campaign_id: string | null
          error_code: string | null
          failure_reason: string | null
          pct_of_failures: number | null
          recipient_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      vw_campaign_metrics: {
        Row: {
          attributed_orders: number | null
          attributed_revenue: number | null
          campaign_id: string | null
          contradictory_status_count: number | null
          delivered_count: number | null
          delivery_rate: number | null
          failed_count: number | null
          read_count: number | null
          read_rate: number | null
          sent_count: number | null
          sent_count_attempted: number | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      vw_campaign_store_impact: {
        Row: {
          campaign_date: string | null
          campaign_id: string | null
          evidence_tier: string | null
          net_sales_7d_after: number | null
          net_sales_7d_before: number | null
          sales_change_pct: number | null
          store_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_stores_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  ops: {
    Tables: {
      action_items: {
        Row: {
          created_at: string
          evidence: Json
          id: string
          opportunity_size_inr: number | null
          opportunity_type: Database["ops"]["Enums"]["opportunity_type"]
          owner_role: Database["core"]["Enums"]["app_role"]
          owner_user_id: string | null
          priority: Database["ops"]["Enums"]["action_priority"]
          problem_statement: string
          recommended_action: string
          resolved_at: string | null
          result_after: number | null
          result_before: number | null
          result_measured_at: string | null
          result_metric: string | null
          status: Database["ops"]["Enums"]["action_status"]
          store_id: string | null
        }
        Insert: {
          created_at?: string
          evidence?: Json
          id?: string
          opportunity_size_inr?: number | null
          opportunity_type: Database["ops"]["Enums"]["opportunity_type"]
          owner_role: Database["core"]["Enums"]["app_role"]
          owner_user_id?: string | null
          priority: Database["ops"]["Enums"]["action_priority"]
          problem_statement: string
          recommended_action: string
          resolved_at?: string | null
          result_after?: number | null
          result_before?: number | null
          result_measured_at?: string | null
          result_metric?: string | null
          status?: Database["ops"]["Enums"]["action_status"]
          store_id?: string | null
        }
        Update: {
          created_at?: string
          evidence?: Json
          id?: string
          opportunity_size_inr?: number | null
          opportunity_type?: Database["ops"]["Enums"]["opportunity_type"]
          owner_role?: Database["core"]["Enums"]["app_role"]
          owner_user_id?: string | null
          priority?: Database["ops"]["Enums"]["action_priority"]
          problem_statement?: string
          recommended_action?: string
          resolved_at?: string | null
          result_after?: number | null
          result_before?: number | null
          result_measured_at?: string | null
          result_metric?: string | null
          status?: Database["ops"]["Enums"]["action_status"]
          store_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "action_items_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_ebo_conversion_daily"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "action_items_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_footfall_completeness"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "action_items_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_store_health_inputs"
            referencedColumns: ["store_id"]
          },
        ]
      }
      ebo_footfall_daily: {
        Row: {
          date: string
          entered_at: string
          entered_by: string | null
          footfall: number
          id: string
          remarks: string | null
          source: string
          store_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          date: string
          entered_at?: string
          entered_by?: string | null
          footfall: number
          id?: string
          remarks?: string | null
          source?: string
          store_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          date?: string
          entered_at?: string
          entered_by?: string | null
          footfall?: number
          id?: string
          remarks?: string | null
          source?: string
          store_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ebo_footfall_daily_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_ebo_conversion_daily"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_footfall_daily_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_footfall_completeness"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_footfall_daily_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_store_health_inputs"
            referencedColumns: ["store_id"]
          },
        ]
      }
      ebo_monthly_targets: {
        Row: {
          created_at: string
          discounted_target_qty: number
          fresh_target_qty: number
          id: string
          period_month: string
          set_by: string | null
          store_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          discounted_target_qty: number
          fresh_target_qty: number
          id?: string
          period_month: string
          set_by?: string | null
          store_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          discounted_target_qty?: number
          fresh_target_qty?: number
          id?: string
          period_month?: string
          set_by?: string | null
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ebo_monthly_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_ebo_conversion_daily"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_monthly_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_footfall_completeness"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_monthly_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_store_health_inputs"
            referencedColumns: ["store_id"]
          },
        ]
      }
      ebo_targets: {
        Row: {
          created_at: string
          id: string
          period_month: string
          set_by: string | null
          store_id: string
          target_atv: number | null
          target_bills: number | null
          target_conversion: number | null
          target_footfall: number | null
          target_sales: number
          target_upt: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          period_month: string
          set_by?: string | null
          store_id: string
          target_atv?: number | null
          target_bills?: number | null
          target_conversion?: number | null
          target_footfall?: number | null
          target_sales: number
          target_upt?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          period_month?: string
          set_by?: string | null
          store_id?: string
          target_atv?: number | null
          target_bills?: number | null
          target_conversion?: number | null
          target_footfall?: number | null
          target_sales?: number
          target_upt?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ebo_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_ebo_conversion_daily"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_footfall_completeness"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_store_health_inputs"
            referencedColumns: ["store_id"]
          },
        ]
      }
      health_score_factors: {
        Row: {
          factor_key: string
          good_value: number
          is_active: boolean
          label: string
          poor_value: number
          weight: number
        }
        Insert: {
          factor_key: string
          good_value: number
          is_active?: boolean
          label: string
          poor_value: number
          weight: number
        }
        Update: {
          factor_key?: string
          good_value?: number
          is_active?: boolean
          label?: string
          poor_value?: number
          weight?: number
        }
        Relationships: []
      }
      incentive_target_imports: {
        Row: {
          file_name: string
          id: string
          notes: string | null
          status: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          file_name: string
          id?: string
          notes?: string | null
          status?: string
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          file_name?: string
          id?: string
          notes?: string | null
          status?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      stock_availability_snapshot: {
        Row: {
          as_of_date: string
          availability_pct: number | null
          store_id: string
        }
        Insert: {
          as_of_date: string
          availability_pct?: number | null
          store_id: string
        }
        Update: {
          as_of_date?: string
          availability_pct?: number | null
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_availability_snapshot_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_ebo_conversion_daily"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "stock_availability_snapshot_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_footfall_completeness"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "stock_availability_snapshot_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_store_health_inputs"
            referencedColumns: ["store_id"]
          },
        ]
      }
    }
    Views: {
      vw_action_queue_summary: {
        Row: {
          closed_unmeasured_count: number | null
          measured_count: number | null
          open_count: number | null
        }
        Relationships: []
      }
      vw_ebo_conversion_daily: {
        Row: {
          atv: number | null
          bill_date: string | null
          conversion_pct: number | null
          day_name: string | null
          footfall: number | null
          net_sales: number | null
          retail_week: number | null
          retail_year: number | null
          sale_bills: number | null
          sales_per_footfall: number | null
          store_id: string | null
          upt: number | null
          week_start: string | null
        }
        Relationships: []
      }
      vw_ebo_target_achievement: {
        Row: {
          achievement_pct: number | null
          actual_sales_mtd: number | null
          current_daily_run_rate: number | null
          days_remaining: number | null
          period_end: string | null
          period_month: string | null
          required_daily_run_rate: number | null
          store_id: string | null
          target_gap: number | null
          target_sales: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ebo_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_ebo_conversion_daily"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_footfall_completeness"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_store_health_inputs"
            referencedColumns: ["store_id"]
          },
        ]
      }
      vw_footfall_completeness: {
        Row: {
          date: string | null
          entered_at: string | null
          footfall: number | null
          has_footfall: boolean | null
          remarks: string | null
          store_id: string | null
        }
        Relationships: []
      }
      vw_footfall_stats: {
        Row: {
          avg_footfall: number | null
          coeff_variation_pct: number | null
          days_recorded: number | null
          max_footfall: number | null
          min_footfall: number | null
          stddev_footfall: number | null
          store_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ebo_footfall_daily_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_ebo_conversion_daily"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_footfall_daily_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_footfall_completeness"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_footfall_daily_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_store_health_inputs"
            referencedColumns: ["store_id"]
          },
        ]
      }
      vw_monthly_fresh_disc_tracker: {
        Row: {
          date: string | null
          day_name: string | null
          day_of_month: number | null
          days_in_month: number | null
          discounted_actual_qty: number | null
          discounted_cum_qty: number | null
          discounted_mtd_target: number | null
          discounted_target_qty: number | null
          fresh_actual_qty: number | null
          fresh_cum_qty: number | null
          fresh_mtd_target: number | null
          fresh_target_qty: number | null
          period_month: string | null
          store_id: string | null
          target_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ebo_monthly_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_ebo_conversion_daily"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_monthly_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_footfall_completeness"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "ebo_monthly_targets_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "vw_store_health_inputs"
            referencedColumns: ["store_id"]
          },
        ]
      }
      vw_store_health_inputs: {
        Row: {
          atv_vs_network: number | null
          conversion_pct: number | null
          footfall_growth_wow: number | null
          sales_growth_wow: number | null
          store_id: string | null
          target_achievement: number | null
          upt_vs_network: number | null
          week_start: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      fn_compute_store_health: {
        Args: { p_store_id: string }
        Returns: {
          breakdown: Json
          score: number
          status: string
        }[]
      }
      fn_diagnose_store: {
        Args: { p_store_id: string; p_week_start?: string }
        Returns: {
          confidence: string
          diagnosis_code: string
          diagnosis_label: string
          evidence: Json
          recommendation: string
          week_start: string
        }[]
      }
    }
    Enums: {
      action_priority: "P1" | "P2" | "P3"
      action_status:
        | "recommended"
        | "requested"
        | "approved"
        | "rejected"
        | "in_progress"
        | "completed"
        | "result_measured"
      opportunity_type:
        | "marketing"
        | "conversion"
        | "atv"
        | "upt"
        | "stock"
        | "product"
        | "slow_stock"
        | "target_gap"
        | "data_quality"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          key: string
          updated_at: string
          value: string
        }
        Update: {
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      claim_attachments: {
        Row: {
          claim_id: number
          created_at: string
          filename: string
          id: number
          kind: string
          local_path: string
        }
        Insert: {
          claim_id: number
          created_at: string
          filename: string
          id?: number
          kind: string
          local_path: string
        }
        Update: {
          claim_id?: number
          created_at?: string
          filename?: string
          id?: number
          kind?: string
          local_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_attachments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claims: {
        Row: {
          amount: number
          claim_number: string
          created_at: string
          created_by: number | null
          forward_recording_id: number | null
          id: number
          marketplace: string
          notes: string
          order_id: number | null
          return_recording_id: number | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          claim_number: string
          created_at: string
          created_by?: number | null
          forward_recording_id?: number | null
          id?: number
          marketplace: string
          notes: string
          order_id?: number | null
          return_recording_id?: number | null
          status: string
          updated_at: string
        }
        Update: {
          amount?: number
          claim_number?: string
          created_at?: string
          created_by?: number | null
          forward_recording_id?: number | null
          id?: number
          marketplace?: string
          notes?: string
          order_id?: number | null
          return_recording_id?: number | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claims_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_forward_recording_id_fkey"
            columns: ["forward_recording_id"]
            isOneToOne: false
            referencedRelation: "recordings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_return_recording_id_fkey"
            columns: ["return_recording_id"]
            isOneToOne: false
            referencedRelation: "recordings"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          id: number
          is_read: boolean
          kind: string
          message: string
          title: string
          user_id: number | null
        }
        Insert: {
          created_at: string
          id?: number
          is_read: boolean
          kind: string
          message: string
          title: string
          user_id?: number | null
        }
        Update: {
          created_at?: string
          id?: number
          is_read?: boolean
          kind?: string
          message?: string
          title?: string
          user_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          awb: string
          color: string
          courier: string
          created_at: string
          dispatch_date: string | null
          id: number
          marketplace: string
          order_number: string
          order_value: number
          quantity: number
          return_awb: string
          return_date: string | null
          sale_order_number: string
          size: string
          sku: string
          source: string
          status: string
          style: string
          updated_at: string
        }
        Insert: {
          awb: string
          color: string
          courier: string
          created_at: string
          dispatch_date?: string | null
          id?: number
          marketplace: string
          order_number: string
          order_value: number
          quantity: number
          return_awb: string
          return_date?: string | null
          sale_order_number: string
          size: string
          sku: string
          source: string
          status: string
          style: string
          updated_at: string
        }
        Update: {
          awb?: string
          color?: string
          courier?: string
          created_at?: string
          dispatch_date?: string | null
          id?: number
          marketplace?: string
          order_number?: string
          order_value?: number
          quantity?: number
          return_awb?: string
          return_date?: string | null
          sale_order_number?: string
          size?: string
          sku?: string
          source?: string
          status?: string
          style?: string
          updated_at?: string
        }
        Relationships: []
      }
      recordings: {
        Row: {
          awb: string
          created_at: string
          drive_file_id: string
          drive_folder_id: string
          drive_link: string
          duration_seconds: number
          error_message: string
          file_size: number
          filename: string
          id: number
          local_path: string
          marketplace: string
          mime_type: string
          operator_id: number | null
          order_id: number | null
          recording_type: string
          retry_count: number
          sheet_updated: boolean
          station_id: number | null
          status: string
          uploaded_at: string | null
        }
        Insert: {
          awb: string
          created_at: string
          drive_file_id: string
          drive_folder_id: string
          drive_link: string
          duration_seconds: number
          error_message: string
          file_size: number
          filename: string
          id?: number
          local_path: string
          marketplace: string
          mime_type: string
          operator_id?: number | null
          order_id?: number | null
          recording_type: string
          retry_count: number
          sheet_updated: boolean
          station_id?: number | null
          status: string
          uploaded_at?: string | null
        }
        Update: {
          awb?: string
          created_at?: string
          drive_file_id?: string
          drive_folder_id?: string
          drive_link?: string
          duration_seconds?: number
          error_message?: string
          file_size?: number
          filename?: string
          id?: number
          local_path?: string
          marketplace?: string
          mime_type?: string
          operator_id?: number | null
          order_id?: number | null
          recording_type?: string
          retry_count?: number
          sheet_updated?: boolean
          station_id?: number | null
          status?: string
          uploaded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recordings_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recordings_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recordings_station_id_fkey"
            columns: ["station_id"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["id"]
          },
        ]
      }
      stations: {
        Row: {
          camera_label: string
          created_at: string
          id: number
          last_seen: string | null
          name: string
          operator_id: number | null
          station_type: string
          status: string
        }
        Insert: {
          camera_label: string
          created_at: string
          id?: number
          last_seen?: string | null
          name: string
          operator_id?: number | null
          station_type: string
          status: string
        }
        Update: {
          camera_label?: string
          created_at?: string
          id?: number
          last_seen?: string | null
          name?: string
          operator_id?: number | null
          station_type?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "stations_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_google_tokens: {
        Row: {
          created_at: string
          refresh_token: string
          updated_at: string
          user_id: number
        }
        Insert: {
          created_at: string
          refresh_token: string
          updated_at: string
          user_id: number
        }
        Update: {
          created_at?: string
          refresh_token?: string
          updated_at?: string
          user_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_google_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          full_name: string
          id: number
          is_active: boolean
          password_hash: string
          role: string
          username: string
        }
        Insert: {
          created_at: string
          full_name: string
          id?: number
          is_active: boolean
          password_hash: string
          role: string
          username: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: number
          is_active?: boolean
          password_hash?: string
          role?: string
          username?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  sales: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      vw_ebo_agent_daily: {
        Row: {
          agent_name: string | null
          bill_date: string | null
          bills: number | null
          discount: number | null
          gross_sales: number | null
          net_sales: number | null
          quantity: number | null
          store_id: string | null
        }
        Relationships: []
      }
      vw_ebo_bill: {
        Row: {
          bill_date: string | null
          bill_no: string | null
          bill_type: string | null
          campaign_flag: boolean | null
          discount_amount: number | null
          dominant_scheme_group: string | null
          gross_amount: number | null
          has_scheme: boolean | null
          line_count: number | null
          net_amount: number | null
          quantity: number | null
          scheme_group_count: number | null
          store_id: string | null
        }
        Relationships: []
      }
      vw_ebo_sales_daily: {
        Row: {
          atv: number | null
          bill_date: string | null
          day_name: string | null
          discount: number | null
          discount_pct: number | null
          financial_year: string | null
          gross_sales: number | null
          is_weekend: boolean | null
          net_quantity: number | null
          net_sales: number | null
          retail_month: number | null
          retail_quarter: number | null
          retail_week: number | null
          retail_year: number | null
          return_bills: number | null
          returns_value: number | null
          sale_bills: number | null
          sale_quantity: number | null
          store_id: string | null
          upt: number | null
          week_start: string | null
        }
        Relationships: []
      }
      vw_ebo_sales_hourly: {
        Row: {
          bill_date: string | null
          bill_hour: number | null
          bills: number | null
          net_sales: number | null
          quantity: number | null
          store_id: string | null
        }
        Relationships: []
      }
      vw_ebo_sales_lines: {
        Row: {
          agent_name: string | null
          bill_date: string | null
          bill_no: string | null
          bill_time: string | null
          bill_type: string | null
          discount_amount: number | null
          gross_amount: number | null
          item_code: string | null
          net_amount: number | null
          scheme_group_name: string | null
          scheme_name: string | null
          store_id: string | null
          total_quantity: number | null
        }
        Relationships: []
      }
      vw_ebo_sales_monthly: {
        Row: {
          atv: number | null
          discount: number | null
          discount_pct: number | null
          financial_year: string | null
          gross_sales: number | null
          month_start: string | null
          net_quantity: number | null
          net_sales: number | null
          retail_month: number | null
          retail_quarter: number | null
          retail_year: number | null
          return_bills: number | null
          sale_bills: number | null
          sale_quantity: number | null
          store_id: string | null
          upt: number | null
        }
        Relationships: []
      }
      vw_ebo_sales_weekly: {
        Row: {
          atv: number | null
          days_with_data: number | null
          discount: number | null
          discount_pct: number | null
          gross_sales: number | null
          is_complete_week: boolean | null
          net_quantity: number | null
          net_sales: number | null
          retail_week: number | null
          retail_year: number | null
          return_bills: number | null
          sale_bills: number | null
          sale_quantity: number | null
          store_id: string | null
          upt: number | null
          week_first_day_with_data: string | null
          week_last_day_with_data: string | null
          week_start: string | null
        }
        Relationships: []
      }
      vw_ebo_scheme_daily: {
        Row: {
          bill_date: string | null
          bills: number | null
          discount: number | null
          gross_sales: number | null
          net_sales: number | null
          quantity: number | null
          scheme_group: string | null
          store_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  core: {
    Enums: {
      app_role: [
        "super_admin",
        "ho_admin",
        "regional_manager",
        "ebo_manager",
        "marketing",
      ],
    },
  },
  graphql_public: {
    Enums: {},
  },
  marketing: {
    Enums: {},
  },
  ops: {
    Enums: {
      action_priority: ["P1", "P2", "P3"],
      action_status: [
        "recommended",
        "requested",
        "approved",
        "rejected",
        "in_progress",
        "completed",
        "result_measured",
      ],
      opportunity_type: [
        "marketing",
        "conversion",
        "atv",
        "upt",
        "stock",
        "product",
        "slow_stock",
        "target_gap",
        "data_quality",
      ],
    },
  },
  public: {
    Enums: {},
  },
  sales: {
    Enums: {},
  },
} as const
