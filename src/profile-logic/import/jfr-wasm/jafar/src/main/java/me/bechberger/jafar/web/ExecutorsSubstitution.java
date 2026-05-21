package me.bechberger.jafar.web;

import com.oracle.svm.core.annotate.Substitute;
import com.oracle.svm.core.annotate.TargetClass;

import java.util.Collections;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * WASM is single-threaded — {@link Executors#newFixedThreadPool(int, ThreadFactory)} fails because
 * starting a real thread throws {@link IllegalThreadStateException}. jafar-parser's
 * {@code StreamingChunkParser} is the only consumer; route it through a synchronous executor.
 */
@TargetClass(Executors.class)
final class Target_java_util_concurrent_Executors {

    @Substitute
    public static ExecutorService newFixedThreadPool(int nThreads, ThreadFactory threadFactory) {
        return new SameThreadExecutorService();
    }

    @Substitute
    public static ExecutorService newFixedThreadPool(int nThreads) {
        return new SameThreadExecutorService();
    }

    @Substitute
    public static ExecutorService newCachedThreadPool() {
        return new SameThreadExecutorService();
    }

    @Substitute
    public static ExecutorService newCachedThreadPool(ThreadFactory threadFactory) {
        return new SameThreadExecutorService();
    }

    @Substitute
    public static ExecutorService newSingleThreadExecutor() {
        return new SameThreadExecutorService();
    }

    @Substitute
    public static ExecutorService newSingleThreadExecutor(ThreadFactory threadFactory) {
        return new SameThreadExecutorService();
    }
}

/** Runs all submitted work synchronously on the calling thread. */
final class SameThreadExecutorService extends AbstractExecutorService {
    private volatile boolean shutdown = false;

    @Override public void execute(Runnable command) { command.run(); }

    @Override public <T> Future<T> submit(Callable<T> task) {
        try {
            return CompletableFuture.completedFuture(task.call());
        } catch (Throwable t) {
            CompletableFuture<T> f = new CompletableFuture<>();
            f.completeExceptionally(t);
            return f;
        }
    }

    @Override public Future<?> submit(Runnable task) {
        try {
            task.run();
            return CompletableFuture.completedFuture(null);
        } catch (Throwable t) {
            CompletableFuture<Object> f = new CompletableFuture<>();
            f.completeExceptionally(t);
            return f;
        }
    }

    @Override public <T> Future<T> submit(Runnable task, T result) {
        try {
            task.run();
            return CompletableFuture.completedFuture(result);
        } catch (Throwable t) {
            CompletableFuture<T> f = new CompletableFuture<>();
            f.completeExceptionally(t);
            return f;
        }
    }

    @Override public void shutdown() { shutdown = true; }
    @Override public List<Runnable> shutdownNow() { shutdown = true; return Collections.emptyList(); }
    @Override public boolean isShutdown() { return shutdown; }
    @Override public boolean isTerminated() { return shutdown; }
    @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return true; }
}
