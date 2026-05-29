export type Gender = "male" | "female";
export type PreferredGender = "male" | "female" | "both";
export type VoteType = "kiss" | "marry" | "kill";

export type RoundLocation = {
  latitude: number;
  longitude: number;
};

export type RoundUser = {
  id: string;
  target_id: number;
  name: string;
  profile_image_url?: string | null;
  imageUrl?: string | null;
  location?: string | null;
  gender: Gender;
  latitude: number;
  longitude: number;
  distance_km: number;
  is_local_ai_bot?: boolean;
};

export type GetRoundResponse = {
  zone_id: string;
  users: RoundUser[];
};

export type GetRoundBatchResponse = {
  rounds: GetRoundResponse[];
};

export type ZoneDebugNearestProfile = {
  user_id: number;
  name: string;
  distance_km: number;
};

export type ZoneDebugResponse = {
  zone_id: string;
  total_profiles_within_radius: number;
  nearest_profiles: ZoneDebugNearestProfile[];
};

export type VoteInput = {
  target_id: number;
  tip_glasa: VoteType;
};

export type VoteRoundRequest = {
  votes: VoteInput[];
};

export type VoteRoundResponse = {
  status: string;
  saved_votes: number;
};

export type BotFeedbackEntry = {
  actor_user_id: number;
  actor_name: string;
  target_user_id: number;
  target_name: string;
  tip_glasa: VoteType;
  is_for_current_user: boolean;
  timestamp: string;
};

export type BotFeedbackResponse = {
  total: number;
  kisses: number;
  marries: number;
  kills: number;
  recent: BotFeedbackEntry[];
  is_masked?: boolean;
  paywall_message?: string | null;
};

export type LocationOptionCountry = {
  country_code: string;
  country_name: string;
};

export type LocationSelectionResponse = {
  country_code: string;
  country_name: string;
  latitude: number;
  longitude: number;
  server_id: string;
};

export type AuthUser = {
  id: number;
  email: string;
  name: string;
  username?: string | null;
  country_code?: string | null;
  country_name?: string | null;
  gender: Gender;
  preferred_gender: PreferredGender;
  profile_image_url?: string | null;
  otp_verified?: boolean;
  face_verified?: boolean;
  is_premium?: boolean;
  referralCount?: number;
  referral_count?: number;
  rounds_played: number;
};

export type AuthResponse = {
  access_token: string;
  token_type: "bearer";
  user: AuthUser;
};

export type RegisterStartResponse = {
  detail: string;
  email: string;
  verification_required: boolean;
};

export type RegisterRequest = {
  email: string;
  password: string;
  name: string;
  country_code: string;
  gender: Gender;
  preferred_gender: PreferredGender;
};

export type LoginRequest = {
  email: string;
  password: string;
};

export type VerifyRegistrationRequest = {
  email: string;
  code: string;
};

export type UpdateProfileRequest = {
  name?: string;
  country_code?: string;
  gender?: Gender;
  preferred_gender?: PreferredGender;
};

export type LeaderboardEntry = {
  rank: number;
  user_id: number;
  name: string;
  profile_image_url?: string | null;
  score: number;
  kisses: number;
  marries: number;
  kills: number;
  rounds_played: number;
  win_rate: number;
};

export type LeaderboardResponse = {
  users: LeaderboardEntry[];
  current_user_rank?: LeaderboardEntry | null;
  country_code?: string | null;
  country_name?: string | null;
  mode?: string | null;
};
