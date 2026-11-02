export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Beacon {
	version: 1;
	pid: number;
	startTime: string;
	cwd: string;
	sessionFile: string | null;
	sessionId: string;
	sessionName: string | null;
	flags: string[];
	tmuxSession: string | null;
	updatedAt: string;
}

export interface HyprClient {
	address: string;
	class: string;
	pid: number;
	workspace: { id: number; name: string };
	monitor: number;
	at: [number, number];
	size: [number, number];
	floating: boolean;
	fullscreen: number;
	hidden: boolean;
	mapped: boolean;
	focusHistoryID: number;
}

export interface HyprMonitor {
	id: number;
	name: string;
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
	transform: number;
	focused: boolean;
	activeWorkspace: { id: number; name: string };
}

export interface HyprWorkspace {
	id: number;
	name: string;
	monitor: string;
	windows: number;
	tiledLayout?: string;
}

export interface MonitorInfo {
	name: string;
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
	transform: number;
	focused: boolean;
	activeWorkspace: string;
}

export interface WorkspaceInfo {
	id: number;
	name: string;
	monitor: string;
}

export interface Agent {
	workspace: WorkspaceInfo;
	monitor: string;
	rect: Rect;
	floating: boolean;
	fullscreen: number;
	hidden: boolean;
	focusHistoryID: number;
	cwd: string;
	sessionFile: string;
	sessionId: string;
	sessionName: string | null;
	flags: string[];
	tmuxSession: string | null;
}

export interface Snapshot {
	version: 1;
	takenAt: string;
	instance: string;
	bootId: string;
	monitors: MonitorInfo[];
	agents: Agent[];
}
