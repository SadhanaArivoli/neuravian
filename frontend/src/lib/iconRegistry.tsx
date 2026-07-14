import type { LucideIcon } from "lucide-react";
import {
  Activity, Archive, BarChart3, Beaker, Brain, CheckCircle2, CircleHelp,
  ClipboardList, Code2, Columns3, Database, Download, FileArchive,
  FileChartColumn, FileCode2, FileJson, FileText, FolderKanban, GitBranch,
  Grid2X2, Home, Image, Info, Keyboard, Layers3, Library, Maximize2, Network,
  PanelRight, Play, Plug, RotateCcw, Save, Search, Settings,
  SlidersHorizontal, Sparkles, Table2, WandSparkles, Workflow, X,
  ZoomIn, ZoomOut,
} from "lucide-react";

export const WorkbenchIcons = {
  activity: Activity, archive: Archive, atlas: Grid2X2, chart: BarChart3,
  code: Code2, compare: Columns3, complete: CheckCircle2, dataset: Database,
  download: Download, file: FileText, folder: FolderKanban, graph: GitBranch,
  help: CircleHelp, home: Home, image: Image, info: Info, inspect: Search,
  github: Code2, keyboard: Keyboard,
  layers: Layers3, library: Library, maximize: Maximize2,
  methods: ClipboardList, network: Network, panel: PanelRight,
  pipeline: Workflow, play: Play, plugin: Plug, project: FolderKanban,
  report: FileChartColumn, reset: RotateCcw, save: Save, settings: Settings,
  sliders: SlidersHorizontal, sparkle: Sparkles, table: Table2, viewer: Brain,
  wizard: WandSparkles, workflow: Workflow, close: X, zoomIn: ZoomIn,
  zoomOut: ZoomOut,
} satisfies Record<string, LucideIcon>;

export function artifactIcon(type = "", name = ""): LucideIcon {
  const value = `${type} ${name}`.toLowerCase();
  if (/nii|nifti|brain|mask|segmentation|statistical.map|connectivity.map/.test(value)) return Brain;
  if (/atlas|roi|label/.test(value)) return Grid2X2;
  if (/matrix|connectivity|adjacency|graph/.test(value)) return Network;
  if (/histogram|plot|figure|png|jpg|jpeg|svg/.test(value)) return Image;
  if (/report|html|markdown|\.md/.test(value)) return FileChartColumn;
  if (/csv|tsv|table/.test(value)) return Table2;
  if (/json|metadata|provenance/.test(value)) return FileJson;
  if (/zip|archive/.test(value)) return FileArchive;
  if (/directory|_dir|folder/.test(value)) return Archive;
  if (/code|script/.test(value)) return FileCode2;
  return FileText;
}

export function pipelineIcon(category = "", id = ""): LucideIcon {
  const value = `${category} ${id}`.toLowerCase();
  if (/connect|graph|network/.test(value)) return Network;
  if (/segment|mask|strip|anat|nifti|statistical|alff|reho/.test(value)) return Brain;
  if (/quality|valid|inspect/.test(value)) return ClipboardList;
  if (/convert|dicom|bids/.test(value)) return WandSparkles;
  if (/report|method/.test(value)) return FileChartColumn;
  if (/plugin/.test(value)) return Plug;
  return Beaker;
}
