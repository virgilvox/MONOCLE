"""Fusion strategies (TSDF, point-map merge) that consume posed depth frames.

Kept separate from the geometry backends so any reconstruction model can pair
with any fusion strategy. The public surface is:

- frames.PosedDepthFrame: a depth frame plus its intrinsics and camera-from-world
  pose, the unit every strategy integrates.
- tsdf.integrate_depth_frames: fuse posed depth frames into a triangle mesh via
  an Open3D scalable TSDF volume.
- cleanup.clean_mesh: repair a fused mesh, keep its largest component, and
  optionally smooth and decimate it.
- export.write_all: write STL/PLY (always) plus GLB/3MF (when trimesh/lib3mf are
  present) in the ReconstructResult shape the app expects; export.write_mesh is
  the Open3D-only convenience used by the fusion round-trip test.

The Open3D-backed functions defer their heavy imports and raise a clear error
naming the 'reconstruct' extra when Open3D is not installed.
"""
