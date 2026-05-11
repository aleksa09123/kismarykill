export type Gender = "male" | "female";
export type PreferredGender = "male" | "female" | "both";
export type VoteType = "kiss" | "marry" | "kill";

export type RoundLocation = {
  latitude: number;
  longitude: number;
};

export type RoundUser = {
  id: number;
  name: string;
  profile_image_url?: string | null;
  gender: Gender;
  latitude: number;
  longitude: number;
  distance_km: number;
};

export type GetRoundRequest = {
  location: RoundLocation;
};

export type GetRoundResponse = {
  zone_id: string;
  users: RoundUser[];
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

export type AuthUser = {
  id: number;
  email: string;
  name: string;
  gender: Gender;
  preferred_gender: PreferredGender;
  profile_image_url?: string | null;
  otp_verified?: boolean;
  face_verified?: boolean;
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
  gender: Gender;
  preferred_gender: PreferredGender;
  profile_image_url?: string;
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
  gender?: Gender;
  preferred_gender?: PreferredGender;
  profile_image_url?: string | null;
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
};

export type LeaderboardResponse = {
  users: LeaderboardEntry[];
};
