"""Input media handling: turn a dropped-in video or image folder into the
frame sequence the reconstruction backends consume.

This package is deliberately separate from the reconstruction engine. Ingestion
(decoding a video, normalizing a folder) and keyframe selection (choosing sharp,
well-spread frames) are input concerns; they produce the same ``frame_00000.png``
sequence a live capture stages, so every existing backend runs over them
unchanged.
"""
