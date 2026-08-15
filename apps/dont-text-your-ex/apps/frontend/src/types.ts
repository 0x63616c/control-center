// Mirrors server/src/types.ts - the API contract.

export interface UserDTO {
  id: string;
  name: string;
  color: string;
  emoji: string | null;
  photo: string | null;
  exes: string[];
}

export interface MeDTO extends UserDTO {
  phone: string | null;
}

export interface MemberDTO {
  user: UserDTO;
  role: "owner" | "member";
  tallyCents: number;
  daysClean: number; // -1 = never caved
  shareStreak: boolean;
}

export interface JarSummaryDTO {
  id: string;
  name: string;
  rule: string;
  defaultCents: number;
  memberIds: string[];
  memberCount: number;
  jarTotalCents: number;
  myTallyCents: number;
  myDaysClean: number;
  myShareStreak: boolean;
}

export interface JarDetailDTO {
  id: string;
  name: string;
  rule: string;
  defaultCents: number;
  inviteCode: string;
  jarTotalCents: number;
  members: MemberDTO[];
  activity: ActivityDTO[];
}

type ActivityType = "slip" | "report" | "join" | "milestone" | "deny";

export interface ActivityDTO {
  id: string;
  jarId: string;
  jarName: string;
  type: ActivityType;
  user: UserDTO | null;
  by: UserDTO | null;
  anonymous: boolean;
  amountCents: number | null;
  exLabel: string | null;
  note: string | null;
  text: string | null;
  ago: string;
}

export interface EvidenceThread {
  to: string;
  time: string;
  bubbles: { me: boolean; text: string }[];
}

interface EvidenceDTO {
  id: string;
  kind: "image";
  thread: EvidenceThread;
}

export interface ReportDTO {
  id: string;
  jarId: string;
  jarName: string;
  accuser: UserDTO | null;
  accused: UserDTO;
  note: string | null;
  anonymous: boolean;
  amountCents: number;
  status: "pending" | "owned" | "denied";
  ago: string;
  evidence: EvidenceDTO[];
}

export interface JarPreviewDTO {
  id: string;
  name: string;
  rule: string;
  defaultCents: number;
  memberIds: string[];
  memberCount: number;
}
