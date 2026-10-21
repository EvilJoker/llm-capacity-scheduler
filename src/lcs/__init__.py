"""lcs — LLM Capacity Scheduler.

容量感知的异步任务调度器：监控多个 provider 的易逝容量窗口，
按策略决定「什么时候、用谁、用多强」执行任务队列。
"""

__version__ = "0.1.0"
