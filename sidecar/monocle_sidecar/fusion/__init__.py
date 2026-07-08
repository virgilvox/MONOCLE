"""Fusion strategies (TSDF, point-map merge) that consume posed depth frames.

Kept separate from the geometry backends so any reconstruction model can pair
with any fusion strategy. The public surface is:

- frames.PosedDepthFrame: a depth frame plus its intrinsics and camera-from-world
  pose, the unit every strategy integrates.
- tsdf.integrate_depth_frames: fuse posed depth frames into a triangle mesh via
  an Open3D scalable TSDF volume.
- export.write_mesh: write a fused mesh as STL (and optional PLY) in the
  ReconstructResult shape the app expects.

The Open3D-backed functions defer their heavy imports and raise a clear error
naming the 'reconstruct' extra when Open3D is not installed.
"""
